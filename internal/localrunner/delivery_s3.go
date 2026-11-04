package localrunner

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// S3 notification delivery.
//
// s3proxy, the profile's S3 backend, has no server-side event hook. The runner
// therefore observes object writes at the S3 protocol boundary: a per-bucket
// watcher reads the bucket with the real ListObjectsV2 API and compares each
// snapshot with the previous one. A create, an overwrite (ETag, size or
// LastModified changed) and a delete each become the documented notification:
// https://docs.aws.amazon.com/AmazonS3/latest/userguide/notification-content-structure.html
//
// What the watcher cannot see is which S3 API made the change, so an observed
// create is reported as ObjectCreated:Put and an observed delete as
// ObjectRemoved:Delete. A create-and-delete inside one poll interval is not
// observed. Both deviations are documented in
// docs/reference/local-runner-configuration.md.

const (
	// defaultS3NotificationInterval is how often the watcher lists a bucket.
	// It is short enough that a row observes the notification promptly and long
	// enough that several buckets stay cheap on the documented Colima host.
	defaultS3NotificationInterval = 250 * time.Millisecond
	// s3NotificationPageLimit bounds the listing pages one poll reads, so a
	// bucket that grows without bound cannot stall delivery.
	s3NotificationPageLimit = 10
)

// s3ObjectState is one object as the bucket reports it.
type s3ObjectState struct {
	ETag         string
	Size         int64
	LastModified time.Time
}

// s3BucketWatcher observes one bucket and dispatches to every registered
// destination configuration.
type s3BucketWatcher struct {
	bucket string
	// name is the physical bucket name provisioning created.
	name string

	mu           sync.Mutex
	destinations []*s3Destination
	known        map[string]s3ObjectState
	baselineSet  bool
	started      bool
}

type s3Destination struct {
	spec  NotificationSpec
	state DeliveryReporter
}

// s3NotificationSupervisor owns the per-bucket watchers for one run.
type s3NotificationSupervisor struct {
	clock    Clock
	logf     func(format string, args ...any)
	interval time.Duration
	// s3Client builds the host-side S3 client; lookup returns the provisioned
	// value for a qualified logical id.
	s3Client func() (*s3.Client, error)
	lookup   func(logicalID string) (resourceValue, bool)
	invoke   func(ctx context.Context, function string, event []byte) (InvokeResult, error)
	sendSQS  func(ctx context.Context, queueURL string, body []byte) error
	// publishSNS publishes one message through the local SNS fan-out.
	publishSNS func(ctx context.Context, topicARN string, message LocalSNSMessage) error
	// publishEvents accepts one entry on the runner-owned EventBridge bus.
	publishEvents func(ctx context.Context, entries []eventBridgeEntry) ([]eventBridgeResult, int)

	mu      sync.Mutex
	buckets map[string]*s3BucketWatcher
}

func newS3NotificationSupervisor(
	clock Clock,
	logf func(format string, args ...any),
	s3Client func() (*s3.Client, error),
	lookup func(logicalID string) (resourceValue, bool),
	invoke func(ctx context.Context, function string, event []byte) (InvokeResult, error),
	sendSQS func(ctx context.Context, queueURL string, body []byte) error,
	publishSNS func(ctx context.Context, topicARN string, message LocalSNSMessage) error,
	publishEvents func(ctx context.Context, entries []eventBridgeEntry) ([]eventBridgeResult, int),
) *s3NotificationSupervisor {
	if clock == nil {
		clock = RealClock{}
	}
	if logf == nil {
		logf = func(string, ...any) {}
	}
	return &s3NotificationSupervisor{
		clock:         clock,
		logf:          logf,
		interval:      defaultS3NotificationInterval,
		s3Client:      s3Client,
		lookup:        lookup,
		invoke:        invoke,
		sendSQS:       sendSQS,
		publishSNS:    publishSNS,
		publishEvents: publishEvents,
		buckets:       map[string]*s3BucketWatcher{},
	}
}

// register adds one destination configuration and starts its bucket watcher on
// first use.
func (s *s3NotificationSupervisor) register(ctx context.Context, notification NotificationSpec, state DeliveryReporter) error {
	if strings.TrimSpace(notification.Bucket) == "" || strings.TrimSpace(notification.BucketName) == "" {
		return fmt.Errorf("notification %s does not name a bucket", notification.LogicalID)
	}
	s.mu.Lock()
	watcher := s.buckets[notification.Bucket]
	if watcher == nil {
		watcher = &s3BucketWatcher{
			bucket: notification.Bucket,
			name:   notification.BucketName,
			known:  map[string]s3ObjectState{},
		}
		s.buckets[notification.Bucket] = watcher
	}
	s.mu.Unlock()

	watcher.mu.Lock()
	watcher.destinations = append(watcher.destinations, &s3Destination{spec: notification, state: state})
	shouldStart := !watcher.started
	watcher.started = true
	watcher.mu.Unlock()

	if !shouldStart {
		return nil
	}
	if s.s3Client == nil {
		return errors.New("the s3 backend is not configured")
	}
	client, err := s.s3Client()
	if err != nil {
		return err
	}
	go s.poll(ctx, watcher, client)
	return nil
}

// poll reads the bucket, reports the changes since the previous snapshot and
// repeats until the run ends. The first successful listing is the baseline: it
// never emits events for objects that existed before the run started.
func (s *s3NotificationSupervisor) poll(ctx context.Context, watcher *s3BucketWatcher, client *s3.Client) {
	done := ctx.Done()
	first := true
	for {
		snapshot, err := listBucketObjects(ctx, client, watcher.name)
		switch {
		case err != nil:
			if ctx.Err() == nil {
				s.logf("s3 notifications %s: list bucket: %v", watcher.bucket, err)
			}
		case first:
			// The first listing is the baseline; the configuration is applied
			// after it, which is when S3 sends the test message.
			s.setBaseline(watcher, snapshot)
			s.sendTestEvents(ctx, watcher)
			first = false
		default:
			s.applySnapshot(ctx, watcher, snapshot)
		}
		select {
		case <-done:
			return
		case <-time.After(s.interval):
		}
	}
}

// setBaseline records the objects that existed before the run started.
func (s *s3NotificationSupervisor) setBaseline(watcher *s3BucketWatcher, snapshot map[string]s3ObjectState) {
	watcher.mu.Lock()
	defer watcher.mu.Unlock()
	watcher.known = snapshot
	watcher.baselineSet = true
}

// applySnapshot diffs one listing against the previous one and dispatches the
// resulting events.
func (s *s3NotificationSupervisor) applySnapshot(ctx context.Context, watcher *s3BucketWatcher, snapshot map[string]s3ObjectState) {
	watcher.mu.Lock()
	if !watcher.baselineSet {
		watcher.known = snapshot
		watcher.baselineSet = true
		watcher.mu.Unlock()
		return
	}
	previous := watcher.known
	if previous == nil {
		previous = map[string]s3ObjectState{}
	}
	watcher.known = snapshot
	destinations := append([]*s3Destination(nil), watcher.destinations...)
	watcher.mu.Unlock()

	now := s.clock.Now().UTC()
	for _, key := range sortedS3Keys(snapshot) {
		object := snapshot[key]
		before, existed := previous[key]
		switch {
		case !existed:
			s.dispatch(ctx, destinations, S3ObjectEvent{
				Bucket: watcher.name, BucketARN: s3BucketARN(watcher.name), Key: key,
				EventName: s3RecordObjectCreatedPut, Size: object.Size, ETag: object.ETag,
				Sequencer: s3Sequencer(object), Time: object.LastModified, Reason: s3ReasonPutObject, Now: now,
			})
		case before.ETag != object.ETag || before.Size != object.Size ||
			!before.LastModified.Equal(object.LastModified):
			s.dispatch(ctx, destinations, S3ObjectEvent{
				Bucket: watcher.name, BucketARN: s3BucketARN(watcher.name), Key: key,
				EventName: s3RecordObjectCreatedPut, Size: object.Size, ETag: object.ETag,
				Sequencer: s3Sequencer(object), Time: object.LastModified, Reason: s3ReasonPutObject, Now: now,
			})
		}
	}
	for _, key := range sortedS3Keys(previous) {
		if _, still := snapshot[key]; still {
			continue
		}
		s.dispatch(ctx, destinations, S3ObjectEvent{
			Bucket: watcher.name, BucketARN: s3BucketARN(watcher.name), Key: key,
			EventName: s3RecordObjectRemovedDelete, Sequencer: s3Sequencer(s3ObjectState{}),
			Time: now, Reason: s3ReasonDeleteObject, Now: now,
		})
	}
}

// dispatch delivers one observed change to every matching destination of the
// bucket.
func (s *s3NotificationSupervisor) dispatch(ctx context.Context, destinations []*s3Destination, event S3ObjectEvent) {
	for _, destination := range destinations {
		if !notificationMatches(destination.spec, event.EventName, event.Key) {
			destination.state.Filtered()
			continue
		}
		if err := s.deliver(ctx, destination.spec, event); err != nil {
			destination.state.Failed(err)
			s.logf("s3 notification %s: %v", destination.spec.LogicalID, err)
			continue
		}
		destination.state.Delivered()
	}
}

// deliver sends one event to its declared destination through the same local
// path the real service would take.
func (s *s3NotificationSupervisor) deliver(ctx context.Context, notification NotificationSpec, event S3ObjectEvent) error {
	event.ConfigurationID = notification.ConfigurationID
	switch notification.DestinationType {
	case notificationDestinationFunction:
		record, err := BuildS3NotificationRecord(event)
		if err != nil {
			return err
		}
		_, err = s.invoke(ctx, notification.Destination, record)
		return err
	case notificationDestinationQueue:
		value, ok := s.lookup(notification.Destination)
		if !ok || value.URL == "" {
			return fmt.Errorf("SQS queue %s is not provisioned", notification.Destination)
		}
		record, err := BuildS3NotificationRecord(event)
		if err != nil {
			return err
		}
		return s.sendSQS(ctx, value.URL, record)
	case notificationDestinationTopic:
		value, ok := s.lookup(notification.Destination)
		if !ok || value.ARN == "" {
			return fmt.Errorf("SNS topic %s is not provisioned", notification.Destination)
		}
		record, err := BuildS3NotificationRecord(event)
		if err != nil {
			return err
		}
		return s.publishSNS(ctx, value.ARN, LocalSNSMessage{Message: string(record)})
	case notificationDestinationEventBridge:
		if s.publishEvents == nil {
			return errors.New("the local EventBridge bus is not running")
		}
		_, failed := s.publishEvents(ctx, []eventBridgeEntry{s3EventBridgeEntry(event)})
		if failed > 0 {
			return errors.New("the local EventBridge bus rejected the event")
		}
		return nil
	//nolint:gocritic // the switch is the destination contract.
	default:
		return fmt.Errorf("notification destination type %q is not supported", notification.DestinationType)
	}
}

// sendTestEvents sends the s3:TestEvent message to every SQS and SNS
// destination of the bucket, as S3 does when a notification configuration is
// applied.
// https://docs.aws.amazon.com/AmazonS3/latest/userguide/notification-content-structure.html
func (s *s3NotificationSupervisor) sendTestEvents(ctx context.Context, watcher *s3BucketWatcher) {
	watcher.mu.Lock()
	destinations := append([]*s3Destination(nil), watcher.destinations...)
	watcher.mu.Unlock()
	message, err := BuildS3TestEvent(watcher.name, s.clock.Now())
	if err != nil {
		s.logf("s3 notifications %s: build test event: %v", watcher.bucket, err)
		return
	}
	for _, destination := range destinations {
		var sendErr error
		switch destination.spec.DestinationType {
		case notificationDestinationQueue:
			value, ok := s.lookup(destination.spec.Destination)
			if !ok || value.URL == "" {
				sendErr = fmt.Errorf("SQS queue %s is not provisioned", destination.spec.Destination)
				break
			}
			sendErr = s.sendSQS(ctx, value.URL, message)
		case notificationDestinationTopic:
			value, ok := s.lookup(destination.spec.Destination)
			if !ok || value.ARN == "" {
				sendErr = fmt.Errorf("SNS topic %s is not provisioned", destination.spec.Destination)
				break
			}
			sendErr = s.publishSNS(ctx, value.ARN, LocalSNSMessage{Message: string(message)})
		default:
			continue
		}
		if sendErr != nil {
			destination.state.Failed(sendErr)
			s.logf("s3 notification %s: test event: %v", destination.spec.LogicalID, sendErr)
			continue
		}
		destination.state.Delivered()
	}
}

// S3NotificationDeliverer registers one destination configuration with the
// supervisor and keeps the source alive for the run.
type S3NotificationDeliverer struct {
	source     DeliverySource
	supervisor *s3NotificationSupervisor
}

// NewS3NotificationDeliverer builds the deliverer for one notification entry.
func NewS3NotificationDeliverer(source DeliverySource, supervisor *s3NotificationSupervisor) (Deliverer, error) {
	if source.Notification == nil {
		return nil, fmt.Errorf("source %s is not an S3 notification", source.ID)
	}
	if supervisor == nil {
		return nil, errors.New("the S3 notification deliverer has no supervisor")
	}
	return &S3NotificationDeliverer{source: source, supervisor: supervisor}, nil
}

// Start registers the configuration and waits until the run ends. The bucket
// watcher owns the poll loop.
func (d *S3NotificationDeliverer) Start(ctx context.Context, env DelivererEnv) error {
	if err := d.supervisor.register(ctx, *d.source.Notification, env.State); err != nil {
		return err
	}
	env.State.SetPhase(DeliveryPhasePolling)
	<-ctx.Done()
	return ctx.Err()
}

// listBucketObjects reads a bucket's current object states with ListObjectsV2.
func listBucketObjects(ctx context.Context, client *s3.Client, bucket string) (map[string]s3ObjectState, error) {
	objects := map[string]s3ObjectState{}
	var token *string
	for page := 0; page < s3NotificationPageLimit; page++ {
		out, err := client.ListObjectsV2(ctx, &s3.ListObjectsV2Input{
			Bucket:            aws.String(bucket),
			ContinuationToken: token,
		})
		if err != nil {
			return nil, err
		}
		for _, object := range out.Contents {
			if object.Key == nil {
				continue
			}
			state := s3ObjectState{ETag: aws.ToString(object.ETag), Size: aws.ToInt64(object.Size)}
			if object.LastModified != nil {
				state.LastModified = object.LastModified.UTC()
			}
			objects[*object.Key] = state
		}
		if !aws.ToBool(out.IsTruncated) || out.NextContinuationToken == nil {
			break
		}
		token = out.NextContinuationToken
	}
	return objects, nil
}

func s3BucketARN(bucket string) string {
	return "arn:" + LocalPartition + ":s3:::" + bucket
}

// s3Sequencer derives the hexadecimal sequence value S3 puts on a PUT or DELETE
// notification. S3 orders events for one key with it; the local value is the
// observation instant in nanoseconds.
func s3Sequencer(object s3ObjectState) string {
	instant := object.LastModified
	if instant.IsZero() {
		instant = time.Now().UTC()
	}
	return fmt.Sprintf("%016X", instant.UnixNano()&0x7FFFFFFFFFFFFFFF)
}

// sortedS3Keys returns the snapshot's keys in lexical order so delivery is
// deterministic.
func sortedS3Keys(states map[string]s3ObjectState) []string {
	keys := make([]string, 0, len(states))
	for key := range states {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
