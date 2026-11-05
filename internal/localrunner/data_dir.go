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
	if err := os.MkdirAll(absolute, 0o750); err != nil {
		return "", fmt.Errorf("create --data-dir %s: %w", absolute, err)
	}
	if err := ensureSharedPath(absolute); err != nil {
		return "", fmt.Errorf("--data-dir: %w", err)
	}
	return absolute, nil
}

// backendDataDir creates and returns one backend's persistent directory.
func (r *Runner) backendDataDir(name string) (string, error) {
	dir := filepath.Join(r.dataDir, name)
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return "", fmt.Errorf("create the %s data directory %s: %w", name, dir, err)
	}
	if err := ensureSharedPath(dir); err != nil {
		return "", fmt.Errorf("the %s data directory: %w", name, err)
	}
	return dir, nil
}

// configureBackendDataDir adapts one profile pin to a persistent data
// directory and returns the bind mounts the container needs. It never changes a
// pin when --data-dir is absent: the default run stays byte-for-byte ephemeral.
func (r *Runner) configureBackendDataDir(backend, container string, pin ContainerPin) (ContainerPin, []string, error) {
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
	case "sqs":
		dir, err := r.backendDataDir("sqs")
		if err != nil {
			return pin, nil, err
		}
		// ElasticMQ's messages-storage keeps queues and messages in an H2
		// in-file database and restores them on startup. The pinned 1.7.1 image
		// was verified to persist a message across a restart.
		// https://github.com/softwaremill/elasticmq
		config, err := r.elasticMQDataConfig(dir)
		if err != nil {
			return pin, nil, err
		}
		return pin, []string{config + ":/opt/elasticmq.conf:ro", dir + ":/data"}, nil
	case "moto":
		r.logf("backend moto: --data-dir keeps no moto state; the pinned moto server holds it in memory (the docs/125 true limit)")
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
// storage under the bind-mounted data directory. The image entrypoint reads
// /opt/elasticmq.conf.
func (r *Runner) elasticMQDataConfig(dataDir string) (string, error) {
	dir := filepath.Join(r.scratch, "elasticmq")
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return "", fmt.Errorf("create the ElasticMQ config directory: %w", err)
	}
	path := filepath.Join(dir, "elasticmq.conf")
	// The H2 URI is fixed to the bind mount so a data directory moved between
	// runs keeps the same database.
	config := "include classpath(\"application.conf\")\n" +
		"messages-storage {\n" +
		"  enabled = true\n" +
		"  uri = \"jdbc:h2:/data/elasticmq\"\n" +
		"}\n"
	if err := os.WriteFile(path, []byte(config), 0o600); err != nil {
		return "", fmt.Errorf("write the ElasticMQ config %s: %w", path, err)
	}
	return path, nil
}
