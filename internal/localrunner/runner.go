package localrunner

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/sqs"

	"github.com/theory-cloud/apptheory/v7/internal/localcloudfront"
)

const (
	defaultMaxConcurrent = maxConcurrency
	// cleanupTimeout bounds the run-wide container listing. Each removal has its
	// own cleanupStepTimeout so one slow Docker call cannot starve the rest.
	cleanupTimeout      = 10 * time.Second
	cleanupStepTimeout  = 5 * time.Second
	labelRun            = "apptheory.local.run"
	labelApp            = "apptheory.local.app"
	labelManaged        = "apptheory.local.managed"
	backendDynamoDB     = "dynamodb"
	backendDynamoDBName = "dynamodb-local"
)

// Options configure one local run.
type Options struct {
	// AppDir is the CDK app directory (the one containing cdk.json).
	AppDir string
	// Context is passed to `cdk synth` as -c key=value.
	Context map[string]string
	// AssemblyDir skips synthesis and reads an existing cloud assembly.
	AssemblyDir string
	// ScratchDir holds synthesis output and materialized inline code. It must
	// live under $HOME or the checkout so Docker can bind-mount it.
	ScratchDir string
	// ProfilePath points at the checked-in local execution profile.
	ProfilePath string
	// Images overrides a profile pin per image class (go, node, python).
	Images map[string]string
	// Endpoints are the local AWS emulators every function container sees.
	Endpoints []Endpoint
	// AddHosts are extra --add-host entries for function containers.
	AddHosts []string
	// Backends are local emulators the runner starts on the run network from
	// the profile (currently: dynamodb). Their endpoints and /etc/hosts entries
	// are added automatically.
	Backends []string
	// PortBase pins the API listener ports; zero asks the OS for free ports.
	PortBase int
	// Ports pins named public surfaces to declared ports. Pinned ports are
	// reserved first and the counter skips them, so unpinned surfaces keep
	// today's allocation for the same base. A pin is only valid with PortBase.
	Ports []PortPin
	// NamePrefix names containers, the network and built images. The default
	// is derived from the app hash, so concurrent runs of one app share names
	// unless a unique prefix is set.
	NamePrefix string
	// MaxConcurrency bounds in-flight invocations; never above 32.
	MaxConcurrency int
	// DeliveryConcurrency bounds concurrent handler invocations the delivery
	// engine performs. Zero uses the documented default.
	DeliveryConcurrency int
	// Clock selects the run's time source: "real" (the default) or
	// "test[=<RFC3339 start>]".
	Clock string
	// Stdout receives the runner's progress log.
	Stdout io.Writer
	// SynthTimeout bounds `cdk synth`.
	SynthTimeout time.Duration
	// Handler runs one handler from a built code directory instead of reading
	// a CDK app. It is for examples that ship a Lambda handler but no CDK
	// definition; the invoke caller supplies every request event.
	Handler *HandlerSpec
	// ExtraFunctions names additional CDK functions a session starts even
	// though no route, event source or rule targets them. It exists for
	// examples whose producer is invoked by a caller (the local session).
	ExtraFunctions []string
	// AllowNoSurface lets an invoke read an assembly whose functions have no
	// HTTP route. Run and plan leave it false and refuse such an assembly.
	AllowNoSurface bool
	// Origins maps an external custom origin's domain to a loopback URL the
	// local gateway may reach. An unmapped external origin is refused at plan
	// time.
	Origins map[string]string
	// ViewerCountry is the run's resolved ISO 3166-1 alpha-2 viewer country for
	// CloudFront geo restriction. An empty value is an undetermined location,
	// which CloudFront serves.
	ViewerCountry string
	// RIEMode runs function containers under the image's embedded Runtime
	// Interface Emulator instead of the runner's Runtime API. It exists to
	// compare against the emulator and for an image whose entry script ignores
	// AWS_LAMBDA_RUNTIME_API; it cannot stream incrementally.
	RIEMode bool
	// StreamChunks makes `invoke --stdio` write one chunk event per streamed
	// response chunk before the result line. The default protocol stays one
	// result line per event.
	StreamChunks bool
	// Watch re-synthesizes the app when its sources change, derives a new Spec
	// and restarts only the functions whose execution inputs changed. The
	// listeners and their URLs stay.
	Watch bool
	// DataDir keeps backend state across runs. An empty value keeps today's
	// ephemeral behavior.
	DataDir string
	// SharedDir is the directory co-resident runs share. It holds the IAM plane
	// (`<shared-dir>/iam`), and the co-residence work adds the shared CA beside
	// it. An empty value keeps every run's IAM state inside its own scratch
	// directory.
	SharedDir string
	// Seed is a shell command that runs after provisioning and before the run
	// reports ready. It is how a seed script drives the app through its own
	// code paths.
	Seed string
	// TLS serves every public listener over HTTPS from a certificate that
	// chains to a runner-generated local CA. The default is off: an existing
	// caller keeps plain HTTP URLs, ports and listeners. The profile's
	// `tls.enabled` key is the committed form of the same opt-in.
	TLS bool
	// TLSHost is the public host name the opt-in serves, a `localhost` or
	// `*.localhost` name. The default is app.localhost.
	TLSHost string
	// TLSAuxHosts are additional `*.localhost` names a function container must
	// resolve to the runner's host, for an app-supplied auxiliary service (a
	// local OIDC test IdP) whose own certificate the `apptheory-local tls leaf`
	// command issues from the same CA.
	TLSAuxHosts []string
}

// Runner owns one local run: the derived surface, the Docker network, the
// function containers and the HTTP listeners.
type Runner struct {
	options    Options
	profile    *Profile
	docker     *Docker
	spec       *Spec
	runID      string
	appHash    string
	namePrefix string
	scratch    string
	images     map[string]string
	// imageEnvs caches the environment each runtime image declares, so layer
	// paths can be prepended to the image's own PATH and LD_LIBRARY_PATH.
	imageEnvs map[string]map[string]string
	// builtImages maps a container-image function's logical id to the image the
	// run built for it.
	builtImages map[string]string
	endpoints   []Endpoint
	// profileEndpointServices marks the endpoints that came from the local
	// profile (rather than a caller's --endpoint), so the service fronts only
	// wrap the runner's own backends.
	profileEndpointServices map[string]bool
	invokers                map[string]*FunctionProcess
	backends                map[string]backendProcess
	resourceValues          resourceValues
	tables                  map[string]tableInfo
	localSecrets            map[string]string
	// secretValues holds the provisioned secret strings, keyed by ARN and
	// friendly name. A deploy-time dynamic reference to the same secret resolves
	// to this value instead of the wave-1 deterministic placeholder.
	secretValues map[string]string
	apiURLs      map[string]string
	servers      []*http.Server
	listeners    []net.Listener
	semaphore    chan struct{}
	network      string
	// runtimeAPIGateway remembers the run network's gateway address once a
	// container could not reach a loopback Runtime API listener, so later
	// functions bind it before their container starts.
	runtimeAPIGateway string
	clock             Clock
	delivery          *DeliveryEngine
	// sns is the per-topic hub registry the SNS deliverer attaches to and
	// PublishLocal publishes through.
	sns *snsHubRegistry
	// ttl performs DynamoDB Time to Live on the run clock; ttlTables are the
	// provisioned tables that enabled it.
	ttl       *ttlTracker
	ttlTables map[string]ttlTable
	// eventBus is the runner-owned EventBridge bus; eventBusURL is the loopback
	// URL the harness and a developer use, and the container URL is injected
	// into functions as AWS_ENDPOINT_URL_EVENTS.
	eventBus          *eventBridgeBus
	eventBusURL       string
	eventBusContainer string
	// s3Notifications watches the buckets that declare notification
	// configurations and dispatches the observed changes.
	s3Notifications *s3NotificationSupervisor
	// webSocketManagement serves the @connections API for every WebSocket API
	// the run serves; it is nil when the assembly declares none.
	webSocketManagement *webSocketManagement
	// cloudFrontAPI serves CreateInvalidation/GetInvalidation for every served
	// distribution; cloudFrontAPIURL is the loopback endpoint injected into
	// functions as AWS_ENDPOINT_URL_CLOUDFRONT.
	cloudFrontAPI    *localcloudfront.InvalidationAPI
	cloudFrontAPIURL string
	// cloudFrontGateways and cloudFrontIDs track each served distribution.
	cloudFrontGateways map[string]*localcloudfront.Gateway
	cloudFrontIDs      map[string]string
	// codeBuild serves the CodeBuild control API and runs builds through the
	// local agent; codeBuildURL is the loopback endpoint functions receive as
	// AWS_ENDPOINT_URL_CODEBUILD.
	codeBuild    *codeBuildService
	codeBuildURL string
	// kmsFront serves the KMS operations the run owns (Sign/Verify with
	// MessageType DIGEST, and the symmetric and signing keys --data-dir must
	// keep stable); nil when the run has no moto KMS backend.
	kmsFront *kmsFront
	// s3Front accepts SSE-S3 on PutObject and reports it on HeadObject and
	// GetObject, which the pinned s3proxy refuses; nil when the run has no
	// s3proxy backend.
	s3Front *s3Front
	// transports and webSocketServers are the live listeners a watch reload
	// updates in place. The net.Listener and the server stay; only the route
	// table and the invoker set swap.
	transports       map[string]*Transport
	webSocketServers map[string]*WebSocketServer
	// dataDir is the resolved persistent backend root. Empty means ephemeral.
	dataDir string
	// specMu guards the current Spec while a watch reload replaces it.
	specMu sync.RWMutex
	// reloadMu serializes a watch reload with the session's data operations, so
	// a command never observes a half-applied function set.
	reloadMu sync.RWMutex
	// watch cancels the file watcher and waits for any in-flight synthesis.
	watch *watchSupervisor
	// watchAssembly counts watch syntheses so each gets a fresh directory.
	watchAssembly int
	// tls is the run's local CA and public leaf; nil when the run did not opt
	// in. tlsBundlePath is the host-side trust bundle the session reports.
	tls           *localTLS
	tlsBundlePath string
	// publicTLS is true when the run opted in to HTTPS on its public
	// listeners. The run CA also exists for a run whose only internal HTTPS
	// endpoint is the custom-resource response endpoint; that run serves plain
	// HTTP in front of a client.
	publicTLS bool
	// internalTLS holds the leaf the runner's internal HTTPS endpoints
	// present, issued on first use from the run CA.
	internalTLS internalHTTPS
	// iam is the shared IAM plane this run publishes its role definitions and
	// issued credentials into; iamSTSURL is the STS endpoint functions reach.
	iam            *iamPlane
	iamStartedAt   time.Time
	iamSTSURL      string
	iamCredentials map[string]iamCredentialRecord
	// iamFunctionCredentials indexes the same records by the function they were
	// issued to, which is what a container's environment resolves.
	iamFunctionCredentials map[string]iamCredentialRecord
	// iamMu guards iamCredentials: the STS endpoint mints sessions while the
	// HTTP listeners verify signatures.
	iamMu sync.RWMutex
	// probeCredential is the credential the preflight container runs with; it
	// proves the container's environment carries a runner-issued key.
	probeCredential iamCredentialRecord
	// cfnShimPath is the mounted response-URL port shim a Node container needs
	// when the assembly declares a handler-invoked custom resource.
	cfnShimPath string
	// cfnResponsePort is the port the custom-resource response endpoint listens
	// on, which the shim restores in a provider framework's response request.
	cfnResponsePort string
	// customResources is the CloudFormation custom-resource response endpoint;
	// customResourceData and customResourcePhysicalIDs keep what each handler
	// reported so a GetAtt on the custom resource resolves.
	customResources           *customResourceResponseServer
	customResourceData        map[string]map[string]string
	customResourcePhysicalIDs map[string]string
	// lambdaInvocations is the local Lambda Invoke endpoint a handler reaches
	// when it calls another function (a Custom::Trigger's provider, an
	// AwsCustomResource invoking Lambda, or app code).
	lambdaInvokeURL string
	// publicPorts is every port this run serves a public listener on, so an
	// origin mapping that speaks plain http to one of them fails at start with
	// the fix instead of a 400 on the first request.
	publicPorts map[int]bool
	// surfacePlans is the resolved port allocation, in listener order. Both
	// plan and describe report it, so a pinned port is visible before a
	// listener binds.
	surfacePlans []PublicSurfacePlan
	// surfacePorts maps a served logical id to the port the run binds.
	surfacePorts map[string]int
}

// NewRunner validates the options and prepares the run. It contacts no Docker
// and synthesizes nothing yet.
func NewRunner(options Options) (*Runner, error) {
	options, err := normalizeOptions(options)
	if err != nil {
		return nil, err
	}
	clock, err := ParseClockSpec(options.Clock)
	if err != nil {
		return nil, err
	}

	runner := &Runner{
		options:                 options,
		docker:                  NewDocker(),
		appHash:                 hashOf(options.AppDir),
		runID:                   shortID(),
		invokers:                map[string]*FunctionProcess{},
		backends:                map[string]backendProcess{},
		tables:                  map[string]tableInfo{},
		localSecrets:            map[string]string{},
		apiURLs:                 map[string]string{},
		endpoints:               append([]Endpoint(nil), options.Endpoints...),
		profileEndpointServices: map[string]bool{},
		images:                  map[string]string{},
		imageEnvs:               map[string]map[string]string{},
		builtImages:             map[string]string{},
		cloudFrontGateways:      map[string]*localcloudfront.Gateway{},
		cloudFrontIDs:           map[string]string{},
		transports:              map[string]*Transport{},
		webSocketServers:        map[string]*WebSocketServer{},
		dataDir:                 options.DataDir,
		semaphore:               make(chan struct{}, options.MaxConcurrency),
		clock:                   clock,
		ttl:                     newTTLTracker(),
		ttlTables:               map[string]ttlTable{},
		eventBus:                newEventBridgeBus(clock),
	}
	runner.namePrefix = sanitizeNamePrefix(options.NamePrefix, "apptheory-local-"+runner.appHash)
	runner.network = runner.namePrefix + "-net"
	runner.scratch = filepath.Join(options.ScratchDir, "runs", runner.appHash+"-"+runner.runID)
	if err := ensureSharedPath(runner.scratch); err != nil {
		return nil, err
	}
	if err := runner.loadProfile(); err != nil {
		return nil, err
	}
	// The profile is the committed form of the local-TLS opt-in. A command-line
	// flag can enable it too; neither source is an operator environment
	// variable.
	if runner.profile != nil {
		if runner.profile.TLS.Enabled {
			runner.options.TLS = true
		}
		if strings.TrimSpace(runner.options.TLSHost) == "" {
			runner.options.TLSHost = runner.profile.TLS.Host
		}
	}
	if err := runner.validateEndpoints(); err != nil {
		return nil, err
	}
	if err := runner.validateBackends(); err != nil {
		return nil, err
	}
	runner.delivery = NewDeliveryEngine(
		runner.clock,
		options.DeliveryConcurrency,
		runner.ResolveDeliveryBackend,
		runner.invokeDelivery,
		runner.logf,
	)
	// E1b: an SQS mapping has a deliverer, so plan reports it as registered and
	// a live session polls its ElasticMQ queue. E2: a DynamoDB Streams mapping
	// polls the table's stream on DynamoDB Local. E6: an SNS subscription has a
	// deliverer whose shared topic hub observes publishes through moto and fans
	// them out. Other kinds keep reporting not-delivered with their task until
	// E3 and E5 land.
	runner.delivery.RegisterDeliverer(DeliveryKindSQS, NewSQSDeliverer)
	runner.delivery.RegisterDeliverer(DeliveryKindDynamoDBStream, func(source DeliverySource) (Deliverer, error) {
		return NewDynamoDBStreamDeliverer(source, runner.ttl)
	})
	// E5: a Kinesis mapping polls moto's stream, and a CloudWatch Logs
	// subscription filter polls its log group and delivers the gzip payload to
	// its Lambda or Kinesis destination.
	runner.delivery.RegisterDeliverer(DeliveryKindKinesis, NewKinesisDeliverer)
	runner.delivery.RegisterDeliverer(DeliveryKindCloudWatchLogs, NewCloudWatchLogsDeliverer)
	// E3: schedules fire on the clock and pattern rules register on the
	// runner-owned bus.
	runner.delivery.RegisterDeliverer(DeliveryKindEventBridgeSchedule, func(source DeliverySource) (Deliverer, error) {
		return NewEventBridgeDeliverer(source, runner.eventBus)
	})
	runner.delivery.RegisterDeliverer(DeliveryKindEventBridgeRule, func(source DeliverySource) (Deliverer, error) {
		return NewEventBridgeDeliverer(source, runner.eventBus)
	})
	runner.cloudFrontAPI = localcloudfront.NewInvalidationAPI(clock.Now, runner.logf)
	runner.sns = newSNSHubRegistry(runner.clock, runner.logf, runner.snsQueueLookup, runner.deliverySQSClient)
	runner.delivery.RegisterDeliverer(DeliveryKindSNS, func(source DeliverySource) (Deliverer, error) {
		return NewSNSDeliverer(source, runner.sns)
	})
	// E4: every bucket notification configuration is delivered from an observed
	// change of the real bucket. The supervisor is built here and starts one
	// watcher per bucket when the first configuration registers.
	runner.s3Notifications = newS3NotificationSupervisor(
		runner.clock,
		runner.logf,
		runner.deliveryS3Client,
		runner.provisionedResourceValue,
		runner.invokeDelivery,
		runner.sendLocalSQS,
		runner.PublishLocalMessage,
		func(ctx context.Context, entries []eventBridgeEntry) ([]eventBridgeResult, int) {
			return runner.eventBus.putEvents(ctx, entries)
		},
	)
	runner.delivery.RegisterDeliverer(DeliveryKindS3Notification, func(source DeliverySource) (Deliverer, error) {
		return NewS3NotificationDeliverer(source, runner.s3Notifications)
	})
	return runner, nil
}

// deliveryS3Client builds the host-side S3 client the notification watcher
// reads buckets with.
func (r *Runner) deliveryS3Client() (*s3.Client, error) {
	backend, ok := r.backendForService("s3")
	if !ok || backend.HostURL == "" {
		return nil, errors.New("the s3 backend is not running")
	}
	return newS3Client(backend.HostURL), nil
}

// provisionedResourceValue resolves a qualified or bare logical id against the
// values provisioning created.
func (r *Runner) provisionedResourceValue(logicalID string) (resourceValue, bool) {
	if value, ok := r.resourceValues[logicalID]; ok {
		return value, true
	}
	for key, value := range r.resourceValues {
		if strings.HasSuffix(key, "/"+logicalID) {
			return value, true
		}
	}
	return resourceValue{}, false
}

// sendLocalSQS sends one message to an ElasticMQ queue. The queue URL
// provisioning recorded names the container network address; the host-side
// client needs the published loopback port instead.
func (r *Runner) sendLocalSQS(ctx context.Context, queueURL string, body []byte) error {
	backend, ok := r.backendForService(backendSQS)
	if !ok || backend.HostURL == "" {
		return errors.New("the sqs backend is not running")
	}
	hostURL, err := hostQueueURL(queueURL, backend.HostURL)
	if err != nil {
		return err
	}
	_, err = newSQSClient(backend.HostURL).SendMessage(ctx, &sqs.SendMessageInput{
		QueueUrl:    aws.String(hostURL),
		MessageBody: aws.String(string(body)),
	})
	return err
}

// snsQueueLookup resolves an SQS subscription target from the queues
// provisioning created.
func (r *Runner) snsQueueLookup(logicalID string) (snsQueueTarget, bool) {
	value, ok := r.resourceValues[logicalID]
	if !ok || value.Type != typeSQSQueue || value.Name == "" {
		return snsQueueTarget{}, false
	}
	return snsQueueTarget{Name: value.Name, ARN: value.ARN}, true
}

// deliverySQSClient builds a host-side ElasticMQ client for SNS subscriptions
// that target an SQS queue.
func (r *Runner) deliverySQSClient() (*sqs.Client, error) {
	backend, ok := r.backendForService(backendSQS)
	if !ok || backend.HostURL == "" {
		return nil, errors.New("the sqs backend is not running")
	}
	return newSQSClient(backend.HostURL), nil
}

// normalizeOptions applies defaults and rejects unusable combinations before
// any synthesis or container work.
//
//nolint:gocyclo // one validation per option.
func normalizeOptions(options Options) (Options, error) {
	options.Stdout = outputOrDefault(options.Stdout)
	if options.Handler != nil {
		if err := normalizeHandlerSpec(options.Handler); err != nil {
			return Options{}, err
		}
		if strings.TrimSpace(options.AppDir) == "" {
			options.AppDir = options.Handler.CodeDir
		}
	}
	if strings.TrimSpace(options.AppDir) == "" {
		return Options{}, errors.New("a CDK app directory is required (--app)")
	}
	appDir, err := filepath.Abs(options.AppDir)
	if err != nil {
		return Options{}, fmt.Errorf("resolve app directory %q: %w", options.AppDir, err)
	}
	options.AppDir = appDir
	if info, statErr := os.Stat(appDir); statErr != nil || !info.IsDir() {
		return Options{}, fmt.Errorf("app directory %s is not a directory", appDir)
	}
	if options.ScratchDir == "" {
		cache, cacheErr := os.UserCacheDir()
		if cacheErr != nil {
			return Options{}, fmt.Errorf("resolve the user cache directory for the run scratch space: %w", cacheErr)
		}
		options.ScratchDir = filepath.Join(cache, "apptheory-local")
	}
	if options.Watch && options.Handler != nil {
		return Options{}, errors.New("--watch needs a CDK app; handler mode has no definition to re-synthesize")
	}
	if options.Watch && strings.TrimSpace(options.AssemblyDir) != "" {
		return Options{}, errors.New("--watch needs the CDK app sources; it cannot watch a fixed --assembly")
	}
	options.DataDir, err = normalizeDataDir(options.DataDir)
	if err != nil {
		return Options{}, err
	}
	options, err = normalizeConcurrency(options)
	if err != nil {
		return Options{}, err
	}
	if options.PortBase < 0 {
		return Options{}, fmt.Errorf("--port-base must not be negative")
	}
	if options.SynthTimeout <= 0 {
		options.SynthTimeout = 30 * time.Minute
	}
	if err := validateOriginOverrides(options.Origins); err != nil {
		return Options{}, err
	}
	country, countryErr := validateViewerCountry(options.ViewerCountry)
	if countryErr != nil {
		return Options{}, countryErr
	}
	options.ViewerCountry = country
	return options, nil
}

// normalizeConcurrency applies the HTTP and delivery-engine defaults and
// rejects values the documented host cannot run reliably.
func normalizeConcurrency(options Options) (Options, error) {
	if options.MaxConcurrency == 0 {
		options.MaxConcurrency = defaultMaxConcurrent
	}
	if options.MaxConcurrency < 1 || options.MaxConcurrency > maxConcurrency {
		return Options{}, fmt.Errorf(
			"--max-concurrency must be between 1 and %d (got %d): local invocations above that bound are unreliable",
			maxConcurrency,
			options.MaxConcurrency,
		)
	}
	if options.DeliveryConcurrency == 0 {
		options.DeliveryConcurrency = defaultDeliveryConcurrency
	}
	if options.DeliveryConcurrency < 1 || options.DeliveryConcurrency > maxDeliveryConcurrency {
		return Options{}, fmt.Errorf(
			"--delivery-concurrency must be between 1 and %d (got %d): the delivery engine shares the host with the runtime images and the emulators",
			maxDeliveryConcurrency,
			options.DeliveryConcurrency,
		)
	}
	return options, nil
}

func (r *Runner) loadProfile() error {
	if r.options.ProfilePath != "" {
		profile, err := LoadProfile(r.options.ProfilePath)
		if err != nil {
			return err
		}
		r.profile = profile
	}
	for class, image := range r.options.Images {
		if err := validateImageOverride(class, image); err != nil {
			return err
		}
		r.images[class] = image
	}
	return nil
}

func validateImageOverride(class, image string) error {
	if class != imageClassGo && class != imageClassNode && class != imageClassPython {
		return fmt.Errorf("unknown image class %q (want go, node or python)", class)
	}
	_, digest, ok := strings.Cut(image, "@")
	if !ok || !digestPattern.MatchString(digest) {
		return fmt.Errorf("image %q for the %s runtime is not pinned by digest", image, class)
	}
	if prefix := imageTagPrefixes[class]; !strings.HasPrefix(image, prefix) {
		return fmt.Errorf("image %q is not an official %s image (%s)", image, class, prefix)
	}
	return nil
}

func (r *Runner) validateBackends() error {
	for _, backend := range r.options.Backends {
		container := backendContainer(backend)
		if _, err := r.profile.Container(container); err != nil {
			return err
		}
		endpoints := r.profile.EndpointsForContainer(container)
		if backend == backendDynamoDB && !containsEndpointService(endpoints, backendDynamoDB) {
			endpoints = append(endpoints, Endpoint{
				Service: backendDynamoDB,
				URL:     "http://" + backendDynamoDBName + ":8000",
			})
		}
		if len(endpoints) == 0 {
			return fmt.Errorf(
				"backend %q has no endpoints in local profile %s; name at least one endpoint with container %q",
				backend,
				r.profile.Path(),
				container,
			)
		}
		for _, endpoint := range endpoints {
			if _, exists := r.backendEndpoint(endpoint.Service); exists {
				continue
			}
			r.endpoints = append(r.endpoints, endpoint)
			if r.profileEndpointServices != nil {
				r.profileEndpointServices[endpoint.Service] = true
			}
		}
	}
	sort.Slice(r.endpoints, func(i, j int) bool { return r.endpoints[i].Service < r.endpoints[j].Service })
	return nil
}

// backendContainer is the profile container a --backend name selects.
// "dynamodb" keeps the historical DynamoDB Local shortcut.
func backendContainer(backend string) string {
	if backend == backendDynamoDB {
		return backendDynamoDBName
	}
	return backend
}

func containsEndpointService(endpoints []Endpoint, service string) bool {
	for _, endpoint := range endpoints {
		if endpoint.Service == service {
			return true
		}
	}
	return false
}

func (r *Runner) backendEndpoint(service string) (Endpoint, bool) {
	for _, endpoint := range r.endpoints {
		if endpoint.Service == service {
			return endpoint, true
		}
	}
	return Endpoint{}, false
}

func (r *Runner) validateEndpoints() error {
	seen := map[string]struct{}{}
	for _, endpoint := range r.endpoints {
		if err := ValidateEndpoint(endpoint); err != nil {
			return err
		}
		if _, exists := seen[endpoint.Service]; exists {
			return fmt.Errorf("endpoint for service %q is configured twice", endpoint.Service)
		}
		seen[endpoint.Service] = struct{}{}
	}
	sort.Slice(r.endpoints, func(i, j int) bool { return r.endpoints[i].Service < r.endpoints[j].Service })
	return nil
}

// Scratch returns the run's scratch directory.
func (r *Runner) Scratch() string {
	return r.scratch
}

// CleanScratch removes the run's scratch directory. It is safe to call more than
// once and never touches containers or the network.
func (r *Runner) CleanScratch() {
	_ = os.RemoveAll(r.scratch) //nolint:errcheck // scratch cleanup is best effort
}

// Plan synthesizes the app (unless an assembly was supplied) and derives the
// surface. It starts no containers.
func (r *Runner) Plan(ctx context.Context) (*Spec, error) {
	if current := r.CurrentSpec(); current != nil {
		return current, nil
	}
	assemblyDir := r.options.AssemblyDir
	if assemblyDir == "" {
		if mkErr := os.MkdirAll(r.scratch, 0o750); mkErr != nil {
			return nil, fmt.Errorf("create run scratch directory %s: %w", r.scratch, mkErr)
		}
		assemblyDir = filepath.Join(r.scratch, "cdk.out")
		synthCtx, cancel := context.WithTimeout(ctx, r.options.SynthTimeout)
		defer cancel()
		if err := synthRunner(synthCtx, SynthOptions{
			AppDir:    r.options.AppDir,
			OutputDir: assemblyDir,
			Context:   r.options.Context,
			Stderr:    r.options.Stdout,
		}); err != nil {
			return nil, err
		}
	}
	stacks, err := loadAssembly(assemblyDir)
	if err != nil {
		return nil, err
	}
	var spec *Spec
	if r.options.AllowNoSurface {
		spec, err = deriveSpecInternal(assemblyDir, stacks)
	} else {
		spec, err = deriveSpec(assemblyDir, stacks)
	}
	if err != nil {
		return nil, err
	}
	if err := r.applyOriginOverrides(spec); err != nil {
		return nil, err
	}
	localcloudfront.ReportViewerCountry(spec.CloudFront, r.options.ViewerCountry != "")
	if err := r.materializeKeyValueStores(spec); err != nil {
		return nil, err
	}
	refreshCloudFrontSkips(spec)
	if r.delivery != nil {
		spec.Delivery = r.delivery.Planned(spec)
	}
	r.specMu.Lock()
	r.spec = spec
	r.specMu.Unlock()
	return spec, nil
}

// Run plans the app, starts the run's network, proves it cannot reach AWS,
// starts every function the CDK definition targets and serves the derived HTTP
// surface until the context is canceled.
func (r *Runner) Run(ctx context.Context) error {
	cleanup := r.cleanupFunc()
	defer cleanup()

	if _, err := r.prepareRun(ctx); err != nil {
		return err
	}
	r.startWatch(ctx)
	defer r.stopWatch()
	r.logf("local-run: ready")
	return r.serve(ctx)
}

// prepareRun creates the complete local environment a run or a session uses:
// synthesis, images, scratch, network, backends, provisioning, environment
// resolution, preflight, function containers and HTTP listeners. It does not
// log the ready marker or wait; Run and RunSession own those steps.
//
//nolint:gocyclo,gocognit // the startup order is documented and pinned by the docs-order test.
func (r *Runner) prepareRun(ctx context.Context) (*Spec, error) {
	spec, err := r.Plan(ctx)
	if err != nil {
		return nil, err
	}
	targets, err := r.runtimeFunctions(spec)
	if err != nil {
		return nil, err
	}
	for _, skipped := range spec.Skipped {
		r.logf("not served: %s (%s): %s", skipped.LogicalID, skipped.Kind, skipped.Reason)
	}
	if err = r.docker.Available(ctx); err != nil {
		return nil, err
	}
	arch, err := r.docker.ServerArch(ctx)
	if err != nil {
		return nil, err
	}
	if err = r.resolveImages(spec, arch, targets); err != nil {
		return nil, err
	}
	if err = r.prepareScratch(spec); err != nil {
		return nil, err
	}

	if err = r.docker.CreateNetwork(ctx, r.network, r.labels()); err != nil {
		return nil, err
	}
	r.logf("network %s", r.network)
	r.chooseRuntimeAPIAddress(ctx)
	if err = r.initTLS(spec); err != nil {
		return nil, err
	}
	if err = r.startBackends(ctx); err != nil {
		return nil, err
	}
	if err = r.startKMSFront(ctx); err != nil {
		return nil, err
	}
	if err = r.startS3Front(ctx); err != nil {
		return nil, err
	}
	if err = r.startEventBridgeBus(ctx); err != nil {
		return nil, err
	}
	if err = r.provisionResources(ctx, spec); err != nil {
		return nil, err
	}
	if err = r.startCognitoIssuer(ctx, spec); err != nil {
		return nil, err
	}
	if err = r.startWebSocketManagement(ctx, spec); err != nil {
		return nil, err
	}
	if err = r.startIAMPlane(spec); err != nil {
		return nil, err
	}
	if err = r.issueCredentials(spec, targets); err != nil {
		return nil, err
	}
	if err = r.startSTSFront(ctx); err != nil {
		return nil, err
	}
	if err = r.publishIAMRun(spec); err != nil {
		return nil, err
	}
	if ctx.Done() != nil {
		go r.refreshIAMRun(ctx, spec)
	}
	if _, err = r.startLambdaInvokeFront(ctx); err != nil {
		return nil, err
	}
	if specNeedsInternalHTTPS(spec) {
		if r.cfnShimPath, err = r.prepareNodeResponseShim(); err != nil {
			return nil, err
		}
		if err = r.startCustomResourceResponses(ctx); err != nil {
			return nil, err
		}
	}
	if err = r.resolveRouteAuthorizers(spec); err != nil {
		return nil, err
	}
	if err = r.startCloudFrontControl(ctx, spec); err != nil {
		return nil, err
	}
	if err = r.startCodeBuildControl(ctx, spec, arch); err != nil {
		return nil, err
	}
	if err = r.resolveEnvironment(spec, targets); err != nil {
		return nil, err
	}
	preflight, err := r.Preflight(ctx, r.network, r.options.AddHosts)
	if err != nil {
		return nil, err
	}
	for _, check := range sortedKeys(preflight.Checks) {
		r.logf("preflight %s: %s", check, preflight.Checks[check])
	}
	if err := r.wireS3FrontEndpoint(preflight.HostGateway); err != nil {
		return nil, err
	}
	if err := r.startFunctions(ctx, spec, targets); err != nil {
		return nil, err
	}
	r.startFunctionLogs(ctx, spec, targets)
	if err := r.invokeCustomResources(ctx, spec); err != nil {
		return nil, err
	}
	if err := r.startServers(ctx, spec); err != nil {
		return nil, err
	}
	if err := r.startDelivery(ctx, spec); err != nil {
		return nil, err
	}
	if err := r.runSeed(ctx, spec); err != nil {
		return nil, err
	}
	return spec, nil
}

// CurrentSpec returns the surface the run is serving now. A watch reload
// replaces it under the same lock, so a session's describe reads the new
// definitions without racing the file watcher.
func (r *Runner) CurrentSpec() *Spec {
	r.specMu.RLock()
	defer r.specMu.RUnlock()
	return r.spec
}

// startWebSocketManagement starts the @connections management API when the
// assembly declares a WebSocket API. Every function then receives its endpoint
// as the API Gateway Management API endpoint and the CA it must trust.
func (r *Runner) startWebSocketManagement(ctx context.Context, spec *Spec) error {
	if len(spec.WebSockets) == 0 {
		return nil
	}
	management, err := newWebSocketManagement(r.scratch, r.tls, r.logf)
	if err != nil {
		return err
	}
	listeners, err := r.listenControl(ctx, "WebSocket management")
	if err != nil {
		return err
	}
	if err := management.start(ctx, listeners); err != nil {
		return err
	}
	r.webSocketManagement = management
	return nil
}

// webSocketDomainName is the host:port a WebSocket event reports in
// requestContext.domainName. It is the management endpoint's container-facing
// address, so a handler that builds the management client from the request
// context reaches the local endpoint without any other configuration.
func (r *Runner) webSocketDomainName() string {
	if r.webSocketManagement == nil {
		return ""
	}
	return strings.TrimPrefix(r.webSocketManagement.ContainerURL, "https://")
}

// webSocketCertificateMounts mounts the management CA into a function container
// so its SDK client trusts the `@connections` TLS endpoint. An opted-in run's
// CA signs the management certificate, so the run's shared trust mount covers
// it and this returns nothing.
func (r *Runner) webSocketCertificateMounts() []string {
	return r.webSocketManagement.certificateMounts()
}

// startEventBridgeBus serves the EventBridge PutEvents JSON protocol for the
// functions and the harness. Containers reach it through host.docker.internal,
// which is added as a host entry before the preflight. The bus listens through
// listenControl, which binds loopback and, when the host owns the run network's
// gateway (the Linux bridge case), that gateway address on the same port; on
// Colima and Docker Desktop the gateway belongs to the VM, that bind fails
// harmlessly, and Docker's host-gateway entry forwards the name to the host
// loopback. The URL the session reports stays loopback-only.
func (r *Runner) startEventBridgeBus(ctx context.Context) error {
	listeners, err := r.listenControl(ctx, "EventBridge")
	if err != nil {
		return err
	}
	server := &http.Server{
		Handler: http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			r.eventBus.serveEventBridgeHTTP(ctx, writer, request)
		}),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	r.servers = append(r.servers, server)
	serve := func(listener net.Listener) {
		go func() {
			if serveErr := server.Serve(listener); serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) && !errors.Is(serveErr, net.ErrClosed) {
				r.logf("local EventBridge bus stopped: %v", serveErr)
			}
		}()
	}
	serve(listeners.Loopback)
	if listeners.Gateway != nil {
		serve(listeners.Gateway)
	}
	r.eventBusURL = listeners.HostURL
	r.eventBusContainer = listeners.ContainerURL
	r.endpoints = append(r.endpoints, Endpoint{Service: "events", URL: r.eventBusContainer})
	r.logf("local EventBridge bus at %s (containers: %s)", r.eventBusURL, r.eventBusContainer)
	return nil
}

// runtimeFunctions returns the CDK-targeted function set plus any explicit
// session targets. An explicit target must exist in the assembly; a typo fails
// before a container starts rather than silently starting nothing.
func (r *Runner) runtimeFunctions(spec *Spec) ([]string, error) {
	seen := map[string]struct{}{}
	for _, id := range spec.RuntimeFunctions() {
		seen[id] = struct{}{}
	}
	for _, id := range r.options.ExtraFunctions {
		id = strings.TrimSpace(id)
		if id == "" {
			continue
		}
		if _, ok := spec.Function(id); !ok {
			return nil, fmt.Errorf("session target %q names no function in the assembly", id)
		}
		seen[id] = struct{}{}
	}
	out := make([]string, 0, len(seen))
	for id := range seen {
		out = append(out, id)
	}
	sort.Strings(out)
	return out, nil
}

// backendProcess is a local emulator container the run owns.
type backendProcess struct {
	Container string
	// Alias is the network name the profile's endpoints use, for example
	// "dynamodb-local" or "moto".
	Alias     string
	Endpoints []Endpoint
	// HostURL is the loopback base URL for the runner's own provisioning
	// calls. It is never injected into a function container.
	HostURL string
}

// startBackends starts every local emulator configured from the profile.
func (r *Runner) startBackends(ctx context.Context) error {
	for _, backend := range r.options.Backends {
		if err := r.startBackend(ctx, backend); err != nil {
			return err
		}
	}
	return nil
}

// startBackend starts one emulator, resolves its network address for the
// function containers' closed DNS and waits until its published host port
// answers a read-only protocol call.
//
//nolint:gocyclo // one branch per backend shape.
func (r *Runner) startBackend(ctx context.Context, backend string) error {
	container := backendContainer(backend)
	pin, err := r.profile.Container(container)
	if err != nil {
		return fmt.Errorf("backend %s: %w", backend, err)
	}
	name := r.backendsContainerName(backend)
	pin, dataMounts, err := r.configureBackendDataDir(backend, container, pin)
	if err != nil {
		return err
	}
	endpoints := r.profile.EndpointsForContainer(container)
	if backend == backendDynamoDB && !containsEndpointService(endpoints, backendDynamoDB) {
		endpoints = append(endpoints, Endpoint{Service: backendDynamoDB, URL: "http://" + backendDynamoDBName + ":8000"})
	}
	// Register the container before starting it, so a signal that lands
	// while the start or the address lookup is in flight still cleans it up.
	r.backends[backend] = backendProcess{
		Container: name,
		Alias:     container,
		Endpoints: endpoints,
	}
	options := ContainerOptions{
		Name:    name,
		Network: r.network,
		Aliases: []string{container},
		Image:   pin.Image,
		Command: pin.Command,
		Env:     pin.Environment,
		Mounts:  append(append([]string(nil), pin.Mounts...), dataMounts...),
		Publish: pin.ContainerPort,
		Labels:  r.labels(),
		Detach:  true,
	}
	if _, startErr := r.docker.StartContainer(ctx, options); startErr != nil {
		return startErr
	}
	address, err := r.docker.ContainerIP(ctx, name, r.network)
	if err != nil {
		return err
	}
	r.options.AddHosts = append(r.options.AddHosts, container+":"+address)
	// An S3 SDK picks virtual-hosted addressing for a named endpoint
	// ("bucket.s3proxy") and path addressing for an IP endpoint. s3proxy
	// only serves the latter, so the S3 endpoint uses the container address.
	if container == "s3proxy" {
		for index := range r.endpoints {
			if r.endpoints[index].Service == "s3" {
				r.endpoints[index].URL = fmt.Sprintf("http://%s:%d", address, pin.ContainerPort)
			}
		}
	}
	process := r.backends[backend]
	if pin.ContainerPort > 0 {
		hostPort, portErr := r.docker.PublishedPort(ctx, name, pin.ContainerPort)
		if portErr != nil {
			return portErr
		}
		if hostPort == 0 {
			return fmt.Errorf("backend %s published no loopback port for container port %d", backend, pin.ContainerPort)
		}
		process.HostURL = fmt.Sprintf("http://127.0.0.1:%d", hostPort)
	}
	r.backends[backend] = process
	// A backend with a published host port must answer a real request before
	// the runner provisions against it or reports it ready. The container may
	// already accept TCP connections while its HTTP server still resets the
	// first request.
	if process.HostURL != "" {
		if err := r.waitForBackendReady(ctx, backend, pin.Image, process); err != nil {
			return err
		}
	}
	var urls []string
	for _, endpoint := range endpoints {
		urls = append(urls, endpoint.URL)
	}
	r.logf("backend %s (%s) ready at %s", backend, pin.Image, strings.Join(urls, ", "))
	return nil
}

func (r *Runner) backendsContainerName(backend string) string {
	if backend == backendDynamoDB {
		return r.namePrefix + "-" + backendDynamoDB
	}
	return r.namePrefix + "-" + sanitizeName(backend)
}

// cleanupFunc removes everything the run created. It drains and stops the
// delivery engine first, while the containers can still accept a delivery that
// is in flight; then it stops accepting requests, then force-removes the
// containers (which also aborts an in-flight RIE invocation), then closes any
// transport connections that are still open. The order matters: waiting for a
// graceful HTTP shutdown before touching Docker can consume the whole cleanup
// budget and leave containers and the network behind when a handler is still
// running.
func (r *Runner) cleanupFunc() func() {
	return func() {
		if r.delivery != nil {
			stopCtx, cancel := context.WithTimeout(context.Background(), cleanupStepTimeout)
			if err := r.delivery.Stop(stopCtx); err != nil {
				r.logf("delivery engine shutdown: %v", err)
			}
			cancel()
		}
		if r.webSocketManagement != nil {
			r.webSocketManagement.close()
		}
		for _, listener := range r.listeners {
			_ = listener.Close() //nolint:errcheck // shutting down the run's own listeners
		}
		r.removeRunContainers()
		for _, server := range r.servers {
			_ = server.Close() //nolint:errcheck // abort connections whose containers are gone
		}
		networkCtx, cancel := context.WithTimeout(context.Background(), cleanupStepTimeout)
		r.docker.RemoveNetwork(networkCtx, r.network)
		cancel()
		r.stopIAMPlane()
		_ = os.RemoveAll(r.scratch) //nolint:errcheck // scratch cleanup is best effort
	}
}

// removeRunContainers removes every container the run created. It lists by the
// run label instead of trusting the tracked map, because a `docker run` that
// was interrupted by the signal can create the container before the runner has
// finished registering it. A second listing catches a container the daemon
// created while the first sweep was running. Tracked names are attempted too,
// so a failed listing cannot leak a known container.
func (r *Runner) removeRunContainers() {
	deadline := time.Now().Add(cleanupTimeout)
	removed := map[string]struct{}{}
	for pass := 0; pass < 2; pass++ {
		pending := map[string]struct{}{}
		listCtx, cancel := cleanupOperationContext(deadline)
		names, err := r.docker.ListContainers(listCtx, labelRun+"="+r.runID)
		cancel()
		if err == nil {
			for _, name := range names {
				pending[name] = struct{}{}
			}
		}
		for _, process := range r.invokers {
			pending[process.Container] = struct{}{}
		}
		for _, backend := range r.backends {
			pending[backend.Container] = struct{}{}
		}
		var wait sync.WaitGroup
		for name := range pending {
			if _, alreadyRemoved := removed[name]; alreadyRemoved {
				continue
			}
			removed[name] = struct{}{}
			wait.Add(1)
			go func(name string) {
				defer wait.Done()
				removeCtx, removeCancel := cleanupOperationContext(deadline)
				defer removeCancel()
				r.docker.RemoveContainer(removeCtx, name)
			}(name)
		}
		wait.Wait()
	}
	for _, process := range r.invokers {
		process.closeRuntimeAPI()
	}
	r.removeRunImages(deadline)
	r.invokers = map[string]*FunctionProcess{}
	r.backends = map[string]backendProcess{}
}

// removeRunImages removes every image the run built for a container-image
// function, including one whose function failed before it was tracked.
func (r *Runner) removeRunImages(deadline time.Time) {
	removed := map[string]struct{}{}
	imageCtx, cancel := cleanupOperationContext(deadline)
	images, err := r.docker.ListImages(imageCtx, labelRun+"="+r.runID)
	cancel()
	if err == nil {
		for _, image := range images {
			removed[image] = struct{}{}
		}
	}
	for _, tag := range r.builtImages {
		removed[tag] = struct{}{}
	}
	for image := range removed {
		removeCtx, removeCancel := cleanupOperationContext(deadline)
		r.docker.RemoveImage(removeCtx, image)
		removeCancel()
	}
	r.builtImages = map[string]string{}
}

// cleanupOperationContext returns a context bounded by both the remaining
// run-wide budget and one step, so a single slow Docker call cannot consume the
// budget needed to remove the rest.
func cleanupOperationContext(deadline time.Time) (context.Context, context.CancelFunc) {
	remaining := time.Until(deadline)
	if remaining <= 0 {
		remaining = time.Millisecond
	}
	if remaining > cleanupStepTimeout {
		remaining = cleanupStepTimeout
	}
	return context.WithTimeout(context.Background(), remaining)
}

// resolveImages pins every target function's runtime image and checks the
// architecture the handler was built for.
func (r *Runner) resolveImages(spec *Spec, hostArch string, targets []string) error {
	for _, id := range targets {
		function, ok := spec.Function(id)
		if !ok {
			return fmt.Errorf("assembly references function %q but defines no such resource", id)
		}
		if function.ImageAsset != nil {
			// A container-image function carries its runtime in the image; the
			// profile's runtime pins do not apply.
			if function.LayerProblem != "" {
				return unsupported(function.LogicalID, "%s", function.LayerProblem)
			}
			if err := unresolvedLimitsError(function); err != nil {
				return err
			}
			continue
		}
		class, err := RuntimeClass(function.Runtime)
		if err != nil {
			return err
		}
		if _, ok := r.images[class]; !ok {
			image, err := r.profile.ImageFor(function.Runtime)
			if err != nil {
				return fmt.Errorf("function %s (%s): %w", function.LogicalID, function.Runtime, err)
			}
			r.images[class] = image
		}
		if _, err := handlerArgument(function); err != nil {
			return err
		}
		if class == imageClassGo && function.Architecture != "" && !archMatches(hostArch, function.Architecture) {
			return fmt.Errorf(
				"function %s was built for %s but this Docker host is %s; a provided-runtime bootstrap cannot run cross-architecture",
				function.LogicalID,
				function.Architecture,
				hostArch,
			)
		}
	}
	return nil
}

func archMatches(host, declared string) bool {
	normalize := func(value string) string {
		switch strings.ToLower(strings.TrimSpace(value)) {
		case archAMD64Alias, archAMD64:
			return archAMD64
		case archARM64, archARM64Alias:
			return archARM64
		default:
			return strings.ToLower(strings.TrimSpace(value))
		}
	}
	return normalize(host) == normalize(declared)
}

// prepareScratch materializes inline function code under the run scratch
// directory, which lives under $HOME so Docker can bind-mount it.
func (r *Runner) prepareScratch(spec *Spec) error {
	if err := os.MkdirAll(r.scratch, 0o750); err != nil {
		return fmt.Errorf("create run scratch directory %s: %w", r.scratch, err)
	}
	for _, function := range spec.Functions {
		if function.InlineCode == "" {
			continue
		}
		dir := filepath.Join(r.scratch, "inline", sanitizeName(function.LogicalID))
		if err := os.MkdirAll(dir, 0o750); err != nil {
			return fmt.Errorf("materialize inline code for %s: %w", function.LogicalID, err)
		}
		path := filepath.Join(dir, function.InlineFile)
		if err := os.WriteFile(path, []byte(function.InlineCode), 0o600); err != nil {
			return fmt.Errorf("write inline code %s: %w", path, err)
		}
	}
	for index := range spec.Functions {
		if spec.Functions[index].InlineCode == "" {
			continue
		}
		spec.Functions[index].AssetDir = filepath.Join(r.scratch, "inline", sanitizeName(spec.Functions[index].LogicalID))
	}
	for index := range spec.Functions {
		function := &spec.Functions[index]
		if len(function.Layers) == 0 {
			continue
		}
		optDir := filepath.Join(r.scratch, "layers", sanitizeName(function.LogicalID))
		if err := os.RemoveAll(optDir); err != nil {
			return fmt.Errorf("reset the layer directory for %s: %w", function.LogicalID, err)
		}
		if err := os.MkdirAll(optDir, 0o750); err != nil {
			return fmt.Errorf("create the layer directory for %s: %w", function.LogicalID, err)
		}
		// Lambda extracts the layers in the listed order and a later layer's
		// file replaces an earlier one.
		// https://docs.aws.amazon.com/lambda/latest/dg/adding-layers.html
		for _, layer := range function.Layers {
			if err := copyTree(layer.AssetDir, optDir); err != nil {
				return fmt.Errorf("extract layer %s for %s: %w", layer.LogicalID, function.LogicalID, err)
			}
		}
		function.OptDir = optDir
	}
	return nil
}

// copyTree copies one layer's content into the merged /opt directory. Files
// overwrite earlier layers. A relative symlink whose target stays inside the
// layer is materialized as the same symlink, which is what Lambda extracts from
// a layer zip and what CDK's default SymlinkFollowMode.NEVER stores for an
// asset (a Node layer built by `npm install` keeps node_modules/.bin shims as
// symlinks). A symlink with an absolute target, or one that escapes the layer
// root, is refused by name because the merged /opt must not expose a path
// outside the layer. Other special files are skipped.
//
// https://docs.aws.amazon.com/lambda/latest/dg/packaging-layers.html
func copyTree(source, target string) error {
	return filepath.WalkDir(source, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		destination := filepath.Join(target, relative)
		if entry.IsDir() {
			return os.MkdirAll(destination, 0o750)
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return copyLayerSymlink(path, relative, destination)
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return nil
		}
		data, err := os.ReadFile(path) //nolint:gosec // the path is a layer asset inside the cloud assembly
		if err != nil {
			return err
		}
		if err := os.MkdirAll(filepath.Dir(destination), 0o750); err != nil {
			return err
		}
		return os.WriteFile(destination, data, info.Mode().Perm()) //nolint:gosec // destination is inside the run scratch directory
	})
}

// copyLayerSymlink materializes one layer symlink after checking that its
// relative target stays inside the layer root.
func copyLayerSymlink(path, relative, destination string) error {
	linkTarget, readErr := os.Readlink(path) //nolint:gosec // the path is a layer asset inside the cloud assembly
	if readErr != nil {
		return readErr
	}
	if filepath.IsAbs(linkTarget) {
		return fmt.Errorf("layer symlink %s has an absolute target %q; the merged /opt must stay inside the layer", relative, linkTarget)
	}
	resolved := filepath.Clean(filepath.Join(filepath.Dir(relative), linkTarget))
	if resolved == ".." || strings.HasPrefix(resolved, ".."+string(filepath.Separator)) {
		return fmt.Errorf("layer symlink %s escapes the layer root with target %q", relative, linkTarget)
	}
	if err := os.MkdirAll(filepath.Dir(destination), 0o750); err != nil {
		return err
	}
	if err := os.Remove(destination); err != nil && !os.IsNotExist(err) {
		return err
	}
	if err := os.Symlink(linkTarget, destination); err != nil { //nolint:gosec // the target was validated to stay inside the layer
		return err
	}
	return nil
}

func (r *Runner) startFunctions(ctx context.Context, spec *Spec, targets []string) error {
	for _, id := range targets {
		function, _ := spec.Function(id)
		image, err := r.imageFor(ctx, function)
		if err != nil {
			return err
		}
		if err := r.startFunction(ctx, function, image); err != nil {
			return err
		}
	}
	return nil
}

// imageFor returns the image a function runs. A container-image function is
// built from its CDK Docker asset first, so `run` never starts serving before
// the image exists; docker caches the build layers, so a rebuild is cheap.
func (r *Runner) imageFor(ctx context.Context, function FunctionSpec) (string, error) {
	if function.ImageAsset != nil {
		return r.buildFunctionImage(ctx, function)
	}
	class, err := RuntimeClass(function.Runtime)
	if err != nil {
		return "", err
	}
	image, ok := r.images[class]
	if !ok {
		return "", fmt.Errorf("function %s has no resolved image for class %s", function.LogicalID, class)
	}
	return image, nil
}

// buildFunctionImage runs the real docker build for one container-image
// function. The tag is derived from the run prefix and the function's logical
// id, and the image carries the run label so cleanup can remove it.
// https://docs.aws.amazon.com/lambda/latest/dg/images-create.html
func (r *Runner) buildFunctionImage(ctx context.Context, function FunctionSpec) (string, error) {
	if tag, ok := r.builtImages[function.LogicalID]; ok {
		return tag, nil
	}
	asset := function.ImageAsset
	if err := ensureSharedPath(asset.Directory); err != nil {
		return "", fmt.Errorf("function %s: %w", function.LogicalID, err)
	}
	tag := r.functionImageTag(function)
	options := ImageBuildOptions{
		Tag:        tag,
		Directory:  asset.Directory,
		DockerFile: asset.DockerFile,
		BuildArgs:  asset.BuildArgs,
		Target:     asset.Target,
		Platform:   asset.Platform,
		Labels:     r.labels(),
	}
	started := time.Now()
	r.logf("building image %s from %s (the first build compiles the image; docker caches later builds)", tag, asset.Directory)
	if err := r.docker.BuildImage(ctx, options); err != nil {
		return "", fmt.Errorf("function %s: %w", function.LogicalID, err)
	}
	r.logf("built image %s in %s", tag, time.Since(started).Round(time.Second))
	r.builtImages[function.LogicalID] = tag
	return tag, nil
}

// functionImageTag names one function's built image. The name carries the run
// id, so two concurrent runs of the same app never move each other's tag; a
// reload within one run keeps the same tag, and docker's layer cache still
// reuses unchanged build steps.
func (r *Runner) functionImageTag(function FunctionSpec) string {
	return sanitizeName(r.namePrefix + "-" + r.runID + "-" + function.LogicalID + "-image")
}

// networkGateway resolves the run network's gateway address.
func (r *Runner) networkGateway(ctx context.Context) (string, error) {
	return r.docker.NetworkGateway(ctx, r.network)
}

// runtimeHostAddress is the address a container uses to reach the host: the
// run network's gateway when the host owns it (the Linux bridge case), or
// Docker's host-gateway value, which Colima and Docker Desktop forward to the
// host's loopback.
func (r *Runner) runtimeHostAddress() string {
	if r.runtimeAPIGateway != "" {
		return r.runtimeAPIGateway
	}
	return "host-gateway"
}

// addRuntimeHostEntry adds the host.docker.internal mapping once; an entry the
// caller supplied through --add-host wins.
func (r *Runner) addRuntimeHostEntry() {
	r.addHostEntry("host.docker.internal")
}

// addHostEntry maps one name to the container-facing host address once. It is
// the one helper every listener or host mapping the containers use goes
// through.
func (r *Runner) addHostEntry(name string) {
	name = strings.TrimSpace(name)
	if name == "" || hasAddHostName(r.options.AddHosts, name) {
		return
	}
	r.options.AddHosts = append(r.options.AddHosts, name+":"+r.runtimeHostAddress())
}

// runtimeAPIAddressOwner reports whether the host owns an address. Binding an
// ephemeral port and closing it at once is the proof; an address that belongs
// to the Docker VM (Colima, Docker Desktop) fails with EADDRNOTAVAIL.
var runtimeAPIAddressOwner = func(gateway string) bool {
	listener, err := net.Listen("tcp", net.JoinHostPort(gateway, "0"))
	if err != nil {
		return false
	}
	_ = listener.Close() //nolint:errcheck // the probe only proves ownership
	return true
}

// chooseRuntimeAPIAddress decides whether the container reaches the host
// through the run network's gateway. The host owns that address on Linux, so
// the container's host entry can name it and the listener can bind it; on
// Colima and Docker Desktop the address belongs to the VM, the bind fails, and
// the container keeps Docker's host-gateway entry (forwarded to the host's
// loopback). The probe binds an ephemeral port and closes it at once.
func (r *Runner) chooseRuntimeAPIAddress(ctx context.Context) {
	gateway, err := r.networkGateway(ctx)
	if err != nil {
		return
	}
	if !runtimeAPIAddressOwner(gateway) {
		return
	}
	r.runtimeAPIGateway = gateway
	r.logf("runtime API: the container host entry host.docker.internal -> %s (the run network's gateway)", gateway)
}

// rememberRuntimeAPIAddress keeps the gateway bind for later functions once a
// container could not reach loopback.
func (r *Runner) rememberRuntimeAPIAddress(process *FunctionProcess) {
	if process == nil || process.api == nil {
		return
	}
	if gateway := process.api.gatewayBound(); gateway != "" {
		r.runtimeAPIGateway = gateway
	}
}

// functionCommand is the container command: the handler for a zip function, or
// none for a container image, which runs its own entrypoint.
func functionCommand(function FunctionSpec) ([]string, error) {
	if function.ImageAsset != nil {
		return nil, nil
	}
	handler, err := handlerArgument(function)
	if err != nil {
		return nil, err
	}
	return []string{handler}, nil
}

// functionMounts binds the function's code and, when it declares layers, the
// merged /opt directory Lambda would extract the layers into.
func functionMounts(function FunctionSpec) []string {
	mounts := []string{}
	if function.AssetDir != "" {
		mounts = append(mounts, function.AssetDir+":/var/task:ro")
	}
	if function.OptDir != "" {
		mounts = append(mounts, function.OptDir+":/opt:ro")
	}
	return mounts
}

// layerEnvironment adds the documented layer paths to the image's own
// environment: /opt/bin on PATH, /opt/lib on LD_LIBRARY_PATH, the Node module
// directory for a Node runtime, and both Python layer paths -- /opt/python and
// python/lib/python3.x/site-packages -- for a Python runtime.
//
// https://docs.aws.amazon.com/lambda/latest/dg/packaging-layers.html
func (r *Runner) layerEnvironment(ctx context.Context, function FunctionSpec, image string, env map[string]string) (map[string]string, error) {
	imageEnv, err := r.runtimeImageEnv(ctx, image)
	if err != nil {
		return nil, err
	}
	values := make(map[string]string, len(env)+4)
	for name, value := range env {
		values[name] = value
	}
	basePath := strings.TrimSpace(values["PATH"])
	if basePath == "" {
		basePath = strings.TrimSpace(imageEnv["PATH"])
	}
	if basePath == "" {
		basePath = "/usr/local/bin:/usr/bin:/bin"
	}
	values["PATH"] = prependPath("/opt/bin", basePath)
	baseLibraryPath := strings.TrimSpace(values["LD_LIBRARY_PATH"])
	if baseLibraryPath == "" {
		baseLibraryPath = strings.TrimSpace(imageEnv["LD_LIBRARY_PATH"])
	}
	values["LD_LIBRARY_PATH"] = prependPath("/opt/lib", baseLibraryPath)
	switch {
	case strings.HasPrefix(function.Runtime, "nodejs"):
		modules := []string{"/opt/nodejs/node_modules"}
		if major := nodeMajorVersion(function.Runtime); major != "" {
			modules = append(modules, "/opt/nodejs/node"+major+"/node_modules")
		}
		if existing := strings.TrimSpace(values["NODE_PATH"]); existing != "" {
			modules = append(modules, existing)
		}
		values["NODE_PATH"] = strings.Join(modules, ":")
	case strings.HasPrefix(function.Runtime, "python"):
		pythonPath := "/opt/python"
		if sitePackages := pythonSitePackages(function.Runtime); sitePackages != "" {
			// The packaging-layers page lists two Python paths: "python" and
			// "python/lib/python3.x/site-packages (site directories)". A layer
			// built with pip's site-packages layout imports on AWS and must
			// import locally too.
			// https://docs.aws.amazon.com/lambda/latest/dg/packaging-layers.html
			pythonPath += ":" + sitePackages
		}
		if existing := strings.TrimSpace(values["PYTHONPATH"]); existing != "" {
			pythonPath += ":" + existing
		}
		values["PYTHONPATH"] = pythonPath
	}
	return values, nil
}

// pythonSitePackages returns the second documented Python layer path for the
// function's runtime: python3.14 becomes
// /opt/python/lib/python3.14/site-packages.
func pythonSitePackages(runtime string) string {
	major, minor, found := strings.Cut(strings.TrimPrefix(runtime, "python"), ".")
	if !found || major == "" || minor == "" {
		return ""
	}
	for _, part := range []string{major, minor} {
		for _, char := range part {
			if char < '0' || char > '9' {
				return ""
			}
		}
	}
	return "/opt/python/lib/python" + major + "." + minor + "/site-packages"
}

func prependPath(directory, existing string) string {
	if strings.TrimSpace(existing) == "" {
		return directory
	}
	return directory + ":" + existing
}

// nodeMajorVersion turns nodejs24.x into 24.
func nodeMajorVersion(runtime string) string {
	rest := strings.TrimPrefix(runtime, "nodejs")
	major, _, _ := strings.Cut(rest, ".")
	if major == "" {
		return ""
	}
	for _, char := range major {
		if char < '0' || char > '9' {
			return ""
		}
	}
	return major
}

func (r *Runner) runtimeImageEnv(ctx context.Context, image string) (map[string]string, error) {
	if env, ok := r.imageEnvs[image]; ok {
		return env, nil
	}
	env, err := r.docker.ImageEnv(ctx, image)
	if err != nil {
		// The image may not be pulled yet; docker run will pull it. The layer
		// paths are still prepended to a documented default.
		r.logf("image %s environment is not readable yet (%v); using the documented default PATH", image, err)
		env = map[string]string{}
	}
	r.imageEnvs[image] = env
	return env, nil
}

//nolint:gocyclo,gocognit // one explicit branch per supported provider and API kind.
func (r *Runner) startServers(ctx context.Context, spec *Spec) error {
	plans, err := PlanPublicSurfaces(spec, r.options.PortBase, r.options.Ports)
	if err != nil {
		return err
	}
	r.surfacePlans = plans
	r.surfacePorts = make(map[string]int, len(plans))
	for _, plan := range plans {
		r.surfacePorts[plan.LogicalID] = plan.Port
	}
	portFor := func(logicalID string) (int, error) {
		port, ok := r.surfacePorts[logicalID]
		if !ok {
			return 0, fmt.Errorf("the surface plan has no listener for %s", logicalID)
		}
		return port, nil
	}
	targets := append([]APISpec(nil), spec.HTTPAPIs()...)
	for _, url := range spec.FunctionURLs {
		targets = append(targets, functionURLAPI(url))
	}
	invokers := make(map[string]Invoker, len(r.invokers))
	for id, process := range r.invokers {
		invokers[id] = process
	}
	for _, target := range targets {
		transport := NewTransport(target, invokers, r.semaphore, r.logf)
		transport.Clock = r.clock
		transport.IAMAuthorize = r.iamAuthorize
		r.transports[target.LogicalID] = transport
		server := &http.Server{
			Handler:           transport,
			ReadHeaderTimeout: 10 * time.Second,
			IdleTimeout:       60 * time.Second,
		}
		port, portErr := portFor(target.LogicalID)
		if portErr != nil {
			return portErr
		}
		port, err := r.startPublicListener(ctx, port, server, "listener for "+target.LogicalID)
		if err != nil {
			return fmt.Errorf("bind %s listener: %w", target.LogicalID, err)
		}
		r.apiURLs[target.LogicalID] = r.publicURL(port)
		r.logf("serving %s %s at %s", target.Class, target.LogicalID, r.apiURLs[target.LogicalID])
	}
	for _, api := range spec.WebSockets {
		webSocketServer := &WebSocketServer{
			API:        api,
			Invokers:   invokers,
			Clock:      r.clock,
			Semaphore:  r.semaphore,
			Management: r.webSocketManagement,
			Logf:       r.logf,
			Now:        r.now,
			DomainName: r.webSocketDomainName(),
		}
		r.webSocketServers[api.LogicalID] = webSocketServer
		server := &http.Server{
			Handler:           webSocketServer,
			ReadHeaderTimeout: 10 * time.Second,
			IdleTimeout:       60 * time.Second,
		}
		port, portErr := portFor(api.LogicalID)
		if portErr != nil {
			return portErr
		}
		port, err := r.startPublicListener(ctx, port, server, "websocket listener for "+api.LogicalID)
		if err != nil {
			return fmt.Errorf("bind websocket %s listener: %w", api.LogicalID, err)
		}
		r.apiURLs[api.LogicalID] = r.tlsWebSocketURL(port, api.Stage)
		r.logf("serving %s %s at %s", api.Class, api.LogicalID, r.apiURLs[api.LogicalID])
	}
	for _, distribution := range spec.ServableCloudFront() {
		executor := localcloudfront.NewExecutor()
		if distributionHasFunctions(distribution) {
			if err := executor.Available(); err != nil {
				return fmt.Errorf("distribution %s uses CloudFront Functions: %w", distribution.LogicalID, err)
			}
		}
		origins, err := r.cloudFrontOrigins(spec, distribution)
		if err != nil {
			return err
		}
		gateway := localcloudfront.NewGateway(distribution, spec.cloudFrontTopology, origins, executor, r.logf)
		gateway.Now = r.clock.Now
		gateway.ViewerCountry = r.options.ViewerCountry
		gateway.EdgeInvoker = &edgeInvokerAdapter{versions: edgeVersions(spec), invokers: invokers}
		r.cloudFrontGateways[distribution.LogicalID] = gateway
		if r.cloudFrontAPI != nil {
			r.cloudFrontIDs[distribution.LogicalID] = r.cloudFrontAPI.Register(distribution.LogicalID, gateway.Cache)
		}
		server := &http.Server{
			Handler:           gateway,
			ReadHeaderTimeout: 10 * time.Second,
			IdleTimeout:       60 * time.Second,
		}
		port, portErr := portFor(distribution.LogicalID)
		if portErr != nil {
			return portErr
		}
		port, err = r.startPublicListener(ctx, port, server, "cloudfront listener for "+distribution.LogicalID)
		if err != nil {
			return fmt.Errorf("bind cloudfront %s listener: %w", distribution.LogicalID, err)
		}
		r.apiURLs[distribution.LogicalID] = r.publicURL(port)
		r.logf("serving cloudfront %s at %s", distribution.LogicalID, r.apiURLs[distribution.LogicalID])
	}
	return nil
}

func distributionHasFunctions(distribution *localcloudfront.Distribution) bool {
	if distribution.DefaultBehavior != nil &&
		(distribution.DefaultBehavior.ViewerRequestFunction != "" || distribution.DefaultBehavior.ViewerResponseFunction != "") {
		return true
	}
	for _, behavior := range distribution.CacheBehaviors {
		if behavior.ViewerRequestFunction != "" || behavior.ViewerResponseFunction != "" {
			return true
		}
	}
	return false
}

func (r *Runner) listen(ctx context.Context, port int) (net.Listener, error) {
	var listenConfig net.ListenConfig
	if port > 0 {
		return listenConfig.Listen(ctx, "tcp", fmt.Sprintf("127.0.0.1:%d", port))
	}
	return listenConfig.Listen(ctx, "tcp", "127.0.0.1:0")
}

// listenPublic binds one public listener. An opted-in run also binds the run
// network's gateway on the same port when the host owns it (the Linux bridge
// case), because a function container reaches the runner's https URL through
// the one add-host entry. On Colima and Docker Desktop the gateway belongs to
// the VM and that bind fails harmlessly: the container's host-gateway entry
// forwards the name to the host loopback.

func (r *Runner) serve(ctx context.Context) error {
	<-ctx.Done()
	r.logf("shutting down: removing %d container(s) and network %s", len(r.invokers), r.network)
	return nil
}

// Down removes containers and networks a previous run of this app left behind.
func (r *Runner) Down(ctx context.Context) (int, error) {
	if err := r.docker.Available(ctx); err != nil {
		return 0, err
	}
	containers, err := r.docker.ListContainers(ctx, labelApp+"="+r.appHash)
	if err != nil {
		return 0, err
	}
	for _, container := range containers {
		r.docker.RemoveContainer(ctx, container)
	}
	networks, err := r.docker.ListNetworks(ctx, labelApp+"="+r.appHash)
	if err != nil {
		return 0, err
	}
	for _, network := range networks {
		r.docker.RemoveNetwork(ctx, network)
	}
	images, err := r.docker.ListImages(ctx, labelApp+"="+r.appHash)
	if err != nil {
		return 0, err
	}
	for _, image := range images {
		r.docker.RemoveImage(ctx, image)
	}
	return len(containers) + len(networks) + len(images), nil
}

// PlanJSON renders the derived surface for machines (the examples harness and
// future tooling).
func (r *Runner) PlanJSON(spec *Spec) ([]byte, error) {
	listeners, err := r.PublicSurfacePlans(spec)
	if err != nil {
		return nil, err
	}
	document := struct {
		*Spec
		RuntimeMode string              `json:"runtimeMode"`
		Listeners   []PublicSurfacePlan `json:"listeners"`
	}{Spec: spec, RuntimeMode: r.RuntimeMode(), Listeners: listeners}
	return json.MarshalIndent(document, "", "  ")
}

// RuntimeMode names the transport the run uses for its function containers.
func (r *Runner) RuntimeMode() string {
	if r.options.RIEMode {
		return "rie"
	}
	return "runner"
}

func (r *Runner) labels() map[string]string {
	return map[string]string{
		labelRun:     r.runID,
		labelApp:     r.appHash,
		labelManaged: "true",
	}
}

func (r *Runner) containerName(logicalID string) string {
	return r.namePrefix + "-" + sanitizeName(logicalID)
}

func (r *Runner) logf(format string, args ...any) {
	if r.options.Stdout == nil {
		return
	}
	_, _ = fmt.Fprintf(r.options.Stdout, format+"\n", args...) //nolint:errcheck // progress logging
}

// now returns the run's current instant from its clock.
func (r *Runner) now() time.Time {
	if r.clock == nil {
		return RealClock{}.Now()
	}
	return r.clock.Now()
}

func outputOrDefault(writer io.Writer) io.Writer {
	if writer == nil {
		return os.Stdout
	}
	return writer
}

func hashOf(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])[:8]
}

func shortID() string {
	var raw [4]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return hashOf(time.Now().UTC().Format(time.RFC3339Nano))[:8]
	}
	return hex.EncodeToString(raw[:])
}

// sanitizeName makes a logical id usable in a Docker container name.
func sanitizeName(value string) string {
	var builder strings.Builder
	for _, char := range strings.ToLower(value) {
		switch {
		case char >= 'a' && char <= 'z', char >= '0' && char <= '9', char == '-', char == '_', char == '.':
			builder.WriteRune(char)
		default:
			builder.WriteByte('-')
		}
	}
	name := strings.Trim(builder.String(), "-_.")
	if name == "" {
		return ruleTargetFunction
	}
	if len(name) > 40 {
		return name[:31] + "-" + hashOf(name)
	}
	return name
}

func sanitizeNamePrefix(value, fallback string) string {
	prefix := sanitizeName(value)
	if strings.TrimSpace(value) == "" {
		prefix = sanitizeName(fallback)
	}
	return prefix
}

// ensureSharedPath fails when a path Docker must bind-mount is outside the
// directories the Docker VM shares: $HOME and the working directory (the
// checkout).
func ensureSharedPath(path string) error {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return fmt.Errorf("resolve path %q: %w", path, err)
	}
	home, homeErr := os.UserHomeDir()
	if homeErr != nil {
		home = ""
	}
	cwd, cwdErr := os.Getwd()
	if cwdErr != nil {
		cwd = ""
	}
	for _, root := range []string{home, cwd} {
		if root == "" {
			continue
		}
		rel, err := filepath.Rel(root, absolute)
		if err != nil {
			continue
		}
		if rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return nil
		}
	}
	return fmt.Errorf(
		"%s is not under $HOME or the working directory; Docker (colima) does not share it",
		absolute,
	)
}
