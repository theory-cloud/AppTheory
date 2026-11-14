package localrunner

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Persistent data under --data-dir.
//
// The backends that can persist state keep it under one directory per backend:
//
//	<data-dir>/dynamodb   DynamoDB Local -dbPath
//	<data-dir>/s3proxy    s3proxy's jclouds filesystem base directory
//	<data-dir>/sqs        ElasticMQ messages-storage H2 database
//
// moto has no persistence: its server mode keeps state in the process and
// offers only a reset API. Runtime state written into moto is therefore the
// named memory-only limit from docs/125, and --data-dir does not pretend
// otherwise.
//
// https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/DynamoDBLocal.UsageNotes.html
// https://github.com/gaul/s3proxy (filesystem provider, jclouds.filesystem.basedir)
// https://github.com/softwaremill/elasticmq (Persisting queues and messages)
// https://docs.getmoto.org/en/latest/docs/server_mode.html

// normalizeDataDir resolves and validates an explicit data directory. It must
// live under $HOME or the working directory so Docker can bind-mount it.
//
// The root is made traversable for other users (0755). The pinned emulator
// images run as their own non-root users (DynamoDB Local as dynamodblocal,
// ElasticMQ as elasticmq). Colima maps a bind mount's ownership to the
// container user, but a Linux bind mount keeps the host UID, so a private
// 0750 root would make every backend unable to open its store.
func normalizeDataDir(raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", nil
	}
	absolute, err := filepath.Abs(trimmed)
	if err != nil {
		return "", fmt.Errorf("resolve --data-dir %q: %w", trimmed, err)
	}
	if info, statErr := os.Stat(absolute); statErr == nil && !info.IsDir() {
		return "", fmt.Errorf("--data-dir %s is not a directory", absolute)
	} else if statErr != nil && !os.IsNotExist(statErr) {
		return "", fmt.Errorf("stat --data-dir %s: %w", absolute, statErr)
	}
	if err := os.MkdirAll(absolute, 0o755); err != nil { //nolint:gosec // the emulator containers run as non-root users; a Linux bind mount keeps the host UID
		return "", fmt.Errorf("create --data-dir %s: %w", absolute, err)
	}
	// MkdirAll leaves an existing directory's mode alone; a directory made by
	// an older run (or by the user) must still be traversable by the backends.
	if err := os.Chmod(absolute, 0o755); err != nil { //nolint:gosec // the backends must traverse the root as their own non-root users
		return "", fmt.Errorf("make --data-dir %s traversable: %w", absolute, err)
	}
	if err := ensureSharedPath(absolute); err != nil {
		return "", fmt.Errorf("--data-dir: %w", err)
	}
	return absolute, nil
}

// backendDataDir creates and returns one backend's persistent directory. The
// directory is 0777 (sticky bit not set) so the container's own user can create
// its store and the runner can still unlink it on cleanup.
func (r *Runner) backendDataDir(name string) (string, error) {
	dir := filepath.Join(r.dataDir, name)
	if err := os.MkdirAll(dir, 0o777); err != nil { //nolint:gosec // the emulator's own user must write its store through the bind mount
		return "", fmt.Errorf("create the %s data directory %s: %w", name, dir, err)
	}
	if err := os.Chmod(dir, 0o777); err != nil { //nolint:gosec // an existing private directory from an older run must be widened
		return "", fmt.Errorf("make the %s data directory writable: %w", name, err)
	}
	if err := ensureSharedPath(dir); err != nil {
		return "", fmt.Errorf("the %s data directory: %w", name, err)
	}
	return dir, nil
}

// configureBackendDataDir adapts one profile pin to a persistent data
// directory and returns the bind mounts the container needs. It never changes a
// pin when --data-dir is absent: the default run stays byte-for-byte ephemeral.
func (r *Runner) configureBackendDataDir(_ string, container string, pin ContainerPin) (ContainerPin, []string, error) {
	if r.dataDir == "" {
		return pin, nil, nil
	}
	switch container {
	case backendDynamoDBName:
		dir, err := r.backendDataDir("dynamodb")
		if err != nil {
			return pin, nil, err
		}
		// The page says -dbPath is "The directory where DynamoDB writes its
		// database file" and that -dbPath and -inMemory cannot be combined. The
		// pinned command uses -sharedDb, so the persistent form keeps it: "If you
		// use the -sharedDb option, DynamoDB creates a single database file named
		// shared-local-instance.db."
		// https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/DynamoDBLocal.UsageNotes.html
		pin.Command = dynamoDBPersistentCommand(pin.Command)
		return pin, []string{dir + ":/data"}, nil
	case "s3proxy":
		dir, err := r.backendDataDir("s3proxy")
		if err != nil {
			return pin, nil, err
		}
		// The filesystem jclouds provider stores objects on disk under
		// jclouds.filesystem.basedir; a bind-mounted base directory is the
		// persistent store.
		// https://github.com/gaul/s3proxy
		pin.Environment = cloneEnvironment(pin.Environment)
		pin.Environment["JCLOUDS_PROVIDER"] = "filesystem"
		pin.Environment["JCLOUDS_FILESYSTEM_BASEDIR"] = "/data"
		return pin, []string{dir + ":/data"}, nil
	case backendSQS:
		dir, err := r.backendDataDir(backendSQS)
		if err != nil {
			return pin, nil, err
		}
		// ElasticMQ's messages-storage keeps queues and messages in an H2
		// in-file database and restores them on startup. The pinned 1.7.1 image
		// was verified to persist a message across a restart.
		// https://github.com/softwaremill/elasticmq
		config, err := r.elasticMQDataConfig(r.sqsStartupPlans)
		if err != nil {
			return pin, nil, err
		}
		return pin, []string{config + ":/opt/elasticmq.conf:ro", dir + ":/data"}, nil
	case "moto":
		r.logf("backend moto: --data-dir keeps no moto state; the pinned moto server holds it in memory (the docs/125 true limit); the runner's KMS front persists the key material it owns under %s",
			filepath.Join(r.dataDir, "kms", kmsFrontKeyFile))
		return pin, nil, nil
	default:
		return pin, nil, nil
	}
}

// dynamoDBPersistentCommand rewrites the pinned DynamoDB Local command so it
// writes to /data instead of memory. The pinned command is
// "-jar DynamoDBLocal.jar -sharedDb -inMemory"; a profile that already names
// -dbPath keeps its own path.
func dynamoDBPersistentCommand(command []string) []string {
	out := make([]string, 0, len(command)+2)
	skipNext := false
	for _, argument := range command {
		if skipNext {
			skipNext = false
			continue
		}
		switch argument {
		case "-inMemory":
			continue
		case "-dbPath":
			skipNext = true
			continue
		default:
			out = append(out, argument)
		}
	}
	return append(out, "-dbPath", "/data")
}

// elasticMQDataConfig writes the ElasticMQ configuration that enables message
// storage under the bind-mounted data directory and declares the app's queues
// as startup queues. The image entrypoint reads /opt/elasticmq.conf. The file is
// world-readable because the container runs as its own non-root user and a
// Linux bind mount keeps the host UID; it contains no secret (the H2 path and
// queue definitions).
//
// The queues belong in this file, not only in the runner's API provisioning.
// With messages-storage enabled, ElasticMQ binds its REST listener first and
// then runs one asynchronous restore that merges the persisted queues with the
// startup configuration (SqlQueuePersistenceActor.createQueues). An API
// CreateQueue that lands inside that window creates the queue with the request's
// own definition; when the restore then replays the persisted definition, which
// carries the redrive policy the runner sets after creation, the queue manager
// sees two different definitions for one name and returns QueueAlreadyExists.
// ElasticMQServer treats that as fatal and stops the container, so the next run
// never reaches ready. Declaring the queues here makes the restore the only
// creator, and the runner waits for each queue instead of racing it.
// https://github.com/softwaremill/elasticmq/blob/v1.7.1/rest/rest-sqs/src/main/scala/org/elasticmq/server/ElasticMQServer.scala
// https://github.com/softwaremill/elasticmq/blob/v1.7.1/persistence/persistence-sql/src/main/scala/org/elasticmq/persistence/sql/SqlQueuePersistenceActor.scala
func (r *Runner) elasticMQDataConfig(queues []localQueuePlan) (string, error) {
	dir := filepath.Join(r.scratch, "elasticmq")
	if err := os.MkdirAll(dir, 0o755); err != nil { //nolint:gosec // the config directory only holds a world-readable path
		return "", fmt.Errorf("create the ElasticMQ config directory: %w", err)
	}
	path := filepath.Join(dir, "elasticmq.conf")
	// The H2 URI is fixed to the bind mount so a data directory moved between
	// runs keeps the same database.
	var config strings.Builder
	config.WriteString("include classpath(\"application.conf\")\n" +
		"messages-storage {\n" +
		"  enabled = true\n" +
		"  uri = \"jdbc:h2:/data/elasticmq\"\n" +
		"}\n")
	if err := writeElasticMQQueueConfig(&config, queues); err != nil {
		return "", err
	}
	if err := os.WriteFile(path, []byte(config.String()), 0o644); err != nil { //nolint:gosec // the ElasticMQ container user must read the H2 path; no secret
		return "", fmt.Errorf("write the ElasticMQ config %s: %w", path, err)
	}
	return path, nil
}

// writeElasticMQQueueConfig renders the startup `queues` block. Only the
// template's explicit attributes are written, so an absent attribute keeps the
// pinned image's documented default (visibility 30s, delay 0, wait 0):
// https://github.com/softwaremill/elasticmq/blob/v1.7.1/core/src/main/scala/org/elasticmq/CreateQueueDefaults.scala
//
// A FIFO queue's name must end in .fifo: QueueConfigUtil appends the suffix to a
// FIFO entry whose name lacks it, which would create a queue the template never
// named. CloudFormation and AWS SQS require the suffix too.
func writeElasticMQQueueConfig(config *strings.Builder, queues []localQueuePlan) error {
	if len(queues) == 0 {
		return nil
	}
	config.WriteString("queues {\n")
	for _, queue := range queues {
		if queue.props.FifoQueue && !strings.HasSuffix(queue.name, ".fifo") {
			return fmt.Errorf(
				"SQS queue %s is FIFO but its name does not end in .fifo; ElasticMQ appends the suffix to a startup queue, so --data-dir cannot preserve the declared name",
				queue.name,
			)
		}
		fmt.Fprintf(config, "  %s {\n", hoconString(queue.name))
		if queue.props.VisibilityTimeout > 0 {
			fmt.Fprintf(config, "    defaultVisibilityTimeout = %d seconds\n", queue.props.VisibilityTimeout)
		}
		if queue.props.DelaySeconds > 0 {
			fmt.Fprintf(config, "    delay = %d seconds\n", queue.props.DelaySeconds)
		}
		if queue.props.ReceiveMessageWaitTimeSeconds > 0 {
			fmt.Fprintf(config, "    receiveMessageWait = %d seconds\n", queue.props.ReceiveMessageWaitTimeSeconds)
		}
		if queue.props.FifoQueue {
			config.WriteString("    fifo = true\n")
		}
		if queue.props.ContentBasedDeduplication {
			config.WriteString("    contentBasedDeduplication = true\n")
		}
		if queue.deadLetterName != "" {
			config.WriteString("    deadLettersQueue {\n")
			fmt.Fprintf(config, "      name = %s\n", hoconString(queue.deadLetterName))
			fmt.Fprintf(config, "      maxReceiveCount = %d\n", queue.maxReceiveCount)
			config.WriteString("    }\n")
		}
		config.WriteString("  }\n")
	}
	config.WriteString("}\n")
	return nil
}

// hoconString quotes a value for HOCON. Queue names contain only characters
// SQS accepts, but quoting keeps a hand-authored name from changing the file's
// structure.
func hoconString(value string) string {
	replacer := strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", `\n`, "\r", `\r`, "\t", `\t`)
	return `"` + replacer.Replace(value) + `"`
}
