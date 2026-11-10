package localrunner

import (
	"bufio"
	"context"
	"crypto/tls"
	"crypto/x509"
	"io"
	"net"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestSMTPPath(t *testing.T) {
	valid := map[string]string{
		"FROM:<sender@example.test>": "sender@example.test",
		"TO:<member@example.test>":   "member@example.test",
		"FROM:<>":                    "",
	}
	for argument, want := range valid {
		prefix := "FROM:"
		if strings.HasPrefix(argument, "TO:") {
			prefix = "TO:"
		}
		got, ok := smtpPath(argument, prefix)
		if !ok || got != want {
			t.Fatalf("smtpPath(%q) = %q, %v; want %q", argument, got, ok, want)
		}
	}
	for _, argument := range []string{"FROM:sender@example.test", "FROM:<>x", "TO:<>", "FROM:<a@b"} {
		if _, ok := smtpPath(argument, "FROM:"); ok && !strings.HasPrefix(argument, "TO:") {
			t.Fatalf("smtpPath(%q) accepted a malformed path", argument)
		}
	}
}

func TestNormalizeCRLFAndSMTPReason(t *testing.T) {
	raw := "Subject: one\nTo: two\r\n\nbody\rline"
	normalized := normalizeCRLF(raw)
	if strings.Contains(normalized, "\n\n") || !strings.HasPrefix(normalized, "Subject: one\r\n") {
		t.Fatalf("normalized = %q", normalized)
	}
	if reason := smtpReason(io.ErrUnexpectedEOF); strings.Contains(reason, "\n") {
		t.Fatalf("reason = %q", reason)
	}
}

func TestReadSMTPReply(t *testing.T) {
	cases := []struct {
		input string
		code  int
		text  string
		fail  bool
	}{
		{"250 OK\r\n", 250, "OK", false},
		{"250-first\r\n250-second\r\n250 last\r\n", 250, "firstsecondlast", false},
		{"354 End data\r\n", 354, "End data", false},
		{"22\r\n", 0, "", true},
		{"abc nope\r\n", 0, "", true},
	}
	for _, testCase := range cases {
		code, text, err := readSMTPReply(bufio.NewReader(strings.NewReader(testCase.input)))
		if testCase.fail {
			if err == nil {
				t.Fatalf("readSMTPReply(%q) accepted a malformed reply", testCase.input)
			}
			continue
		}
		if err != nil || code != testCase.code || text != testCase.text {
			t.Fatalf("readSMTPReply(%q) = %d %q, %v", testCase.input, code, text, err)
		}
	}
}

// mailSinkRecorder is an in-process SMTP server that records one message.
type mailSinkRecorder struct {
	listener net.Listener
	mu       sync.Mutex
	from     string
	rcpts    []string
	raw      string
	received int
}

func startMailSinkRecorder(t *testing.T) *mailSinkRecorder {
	t.Helper()
	var listenConfig net.ListenConfig
	listener, err := listenConfig.Listen(context.Background(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("sink listener: %v", err)
	}
	sink := &mailSinkRecorder{listener: listener}
	t.Cleanup(func() { _ = listener.Close() }) //nolint:errcheck // test cleanup
	go sink.accept()
	return sink
}

func (s *mailSinkRecorder) addr() string { return s.listener.Addr().String() }

func (s *mailSinkRecorder) accept() {
	for {
		connection, err := s.listener.Accept()
		if err != nil {
			return
		}
		go s.handle(connection)
	}
}

func (s *mailSinkRecorder) handle(connection net.Conn) {
	defer func() { _ = connection.Close() }() //nolint:errcheck // the test sink is done
	reader := bufio.NewReader(connection)
	writer := bufio.NewWriter(connection)
	write := func(line string) {
		_, _ = writer.WriteString(line + "\r\n") //nolint:errcheck // the test sink writes
		_ = writer.Flush()                       //nolint:errcheck // the test sink writes
	}
	write("220 test-sink ESMTP")
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			return
		}
		command := strings.TrimRight(line, "\r\n")
		upper := strings.ToUpper(command)
		switch {
		case strings.HasPrefix(upper, "EHLO"):
			write("250-test-sink")
			write("250 OK")
		case strings.HasPrefix(upper, "MAIL FROM:"):
			s.mu.Lock()
			s.from = strings.TrimSuffix(strings.TrimPrefix(command, "MAIL FROM:<"), ">")
			s.mu.Unlock()
			write("250 OK")
		case strings.HasPrefix(upper, "RCPT TO:"):
			s.mu.Lock()
			s.rcpts = append(s.rcpts, strings.TrimSuffix(strings.TrimPrefix(command, "RCPT TO:<"), ">"))
			s.mu.Unlock()
			write("250 OK")
		case upper == "DATA":
			write("354 End data")
			var body strings.Builder
			for {
				dataLine, dataErr := reader.ReadString('\n')
				if dataErr != nil {
					return
				}
				if dataLine == ".\r\n" || dataLine == ".\n" {
					break
				}
				dataLine = strings.TrimPrefix(dataLine, ".")
				body.WriteString(dataLine)
			}
			s.mu.Lock()
			s.raw = body.String()
			s.received++
			s.mu.Unlock()
			write("250 OK")
		case upper == "QUIT":
			write("221 Bye")
			return
		default:
			write("250 OK")
		}
	}
}

func (s *mailSinkRecorder) snapshot() (string, []string, string, int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.from, append([]string(nil), s.rcpts...), s.raw, s.received
}

func TestRelaySMTP(t *testing.T) {
	sink := startMailSinkRecorder(t)
	raw := "Subject: relay\r\n\r\n.leading dot\r\nbody\r\n"
	if err := relaySMTP(context.Background(), sink.addr(), "sender@example.test",
		[]string{"one@example.test", "two@example.test"}, raw); err != nil {
		t.Fatalf("relaySMTP: %v", err)
	}
	from, rcpts, got, count := sink.snapshot()
	if count != 1 || from != "sender@example.test" || len(rcpts) != 2 {
		t.Fatalf("sink got from=%q rcpts=%v count=%d", from, rcpts, count)
	}
	if got != raw {
		t.Fatalf("sink raw = %q, want %q", got, raw)
	}
}

// smtpTestRunner builds a runner whose mail surface relays to the sink and
// whose spec declares no receipt rules.
func smtpTestRunner(sink *mailSinkRecorder, spec *Spec) *Runner {
	return &Runner{
		spec:  spec,
		clock: RealClock{},
		mail:  &mailSurface{host: mailDefaultHost, relayAddr: sink.addr()},
	}
}

func startSMTPTestServer(t *testing.T, runner *Runner) (string, context.CancelFunc) {
	t.Helper()
	var listenConfig net.ListenConfig
	listener, err := listenConfig.Listen(context.Background(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("ingress listener: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	go runner.serveSMTP(ctx, listener)
	t.Cleanup(func() {
		cancel()
		_ = listener.Close() //nolint:errcheck // test cleanup
	})
	return listener.Addr().String(), cancel
}

func smtpConversation(t *testing.T, address string, tlsConfig *tls.Config) []string {
	t.Helper()
	connection, err := (&net.Dialer{Timeout: 5 * time.Second}).DialContext(context.Background(), "tcp", address)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer func() { _ = connection.Close() }() //nolint:errcheck // test cleanup
	_ = connection.SetDeadline(time.Now().Add(30 * time.Second))
	reader := bufio.NewReader(connection)
	writer := bufio.NewWriter(connection)
	read := func() string {
		line, readErr := reader.ReadString('\n')
		if readErr != nil {
			t.Fatalf("read reply: %v", readErr)
		}
		return strings.TrimRight(line, "\r\n")
	}
	send := func(line string) {
		if _, writeErr := writer.WriteString(line + "\r\n"); writeErr != nil {
			t.Fatalf("write: %v", writeErr)
		}
		if flushErr := writer.Flush(); flushErr != nil {
			t.Fatalf("flush: %v", flushErr)
		}
	}
	var replies []string
	replies = append(replies, read())
	send("EHLO test")
	for {
		reply := read()
		replies = append(replies, reply)
		if len(reply) < 4 || reply[3] != '-' {
			break
		}
	}
	if tlsConfig != nil {
		send("STARTTLS")
		replies = append(replies, read())
		tlsConn := tls.Client(connection, tlsConfig)
		if handshakeErr := tlsConn.HandshakeContext(context.Background()); handshakeErr != nil {
			t.Fatalf("STARTTLS handshake: %v", handshakeErr)
		}
		connection = tlsConn
		reader = bufio.NewReader(tlsConn)
		writer = bufio.NewWriter(tlsConn)
		send("EHLO test")
		replies = append(replies, read())
		for {
			reply := read()
			replies = append(replies, reply)
			if len(reply) < 4 || reply[3] != '-' {
				break
			}
		}
	}
	send("MAIL FROM:<sender@example.test>")
	replies = append(replies, read())
	send("RCPT TO:<member@example.test>")
	replies = append(replies, read())
	send("DATA")
	replies = append(replies, read())
	send("Subject: conversation")
	send("")
	send("hello from the ingress")
	send(".")
	replies = append(replies, read())
	send("RSET")
	replies = append(replies, read())
	send("NOOP")
	replies = append(replies, read())
	send("AUTH PLAIN")
	replies = append(replies, read())
	send("BOGUS")
	replies = append(replies, read())
	send("QUIT")
	replies = append(replies, read())
	return replies
}

func TestSMTPConversation(t *testing.T) {
	sink := startMailSinkRecorder(t)
	runner := smtpTestRunner(sink, &Spec{})
	address, _ := startSMTPTestServer(t, runner)
	replies := smtpConversation(t, address, nil)
	joined := strings.Join(replies, "\n")
	if !strings.Contains(joined, "220 ") || !strings.Contains(joined, "354 ") || !strings.Contains(joined, "250 2.0.0 Ok: queued") {
		t.Fatalf("replies = %v", replies)
	}
	if !strings.Contains(joined, "502 5.5.1 authentication") || !strings.Contains(joined, "502 5.5.2 command not recognized") {
		t.Fatalf("refusals = %v", replies)
	}
	_, _, raw, count := sink.snapshot()
	if count != 1 || !strings.Contains(raw, "hello from the ingress") {
		t.Fatalf("sink raw = %q count=%d", raw, count)
	}
}

func TestSMTPConversationStartTLS(t *testing.T) {
	sink := startMailSinkRecorder(t)
	runner := smtpTestRunner(sink, &Spec{})
	caDir := t.TempDir()
	state, err := newLocalCASigner(caDir)
	if err != nil {
		t.Fatalf("CA: %v", err)
	}
	leaf, err := state.issueCertificate([]string{mailDefaultHost}, nil)
	if err != nil {
		t.Fatalf("leaf: %v", err)
	}
	runner.mail.leaf = &leaf
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(state.caPEM) {
		t.Fatal("the CA is not a PEM certificate")
	}
	address, _ := startSMTPTestServer(t, runner)
	replies := smtpConversation(t, address, &tls.Config{
		MinVersion: tls.VersionTLS12,
		RootCAs:    roots,
		ServerName: mailDefaultHost,
	})
	if !strings.Contains(strings.Join(replies, "\n"), "220 2.0.0 Ready to start TLS") {
		t.Fatalf("no STARTTLS reply: %v", replies)
	}
	_, _, _, count := sink.snapshot()
	if count != 1 {
		t.Fatalf("the sink got %d messages", count)
	}
}

func TestSMTPRefusesBadSequences(t *testing.T) {
	sink := startMailSinkRecorder(t)
	runner := smtpTestRunner(sink, &Spec{})
	address, _ := startSMTPTestServer(t, runner)
	connection, err := (&net.Dialer{Timeout: 5 * time.Second}).DialContext(context.Background(), "tcp", address)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer func() { _ = connection.Close() }() //nolint:errcheck // test cleanup
	reader := bufio.NewReader(connection)
	writer := bufio.NewWriter(connection)
	read := func() string {
		line, readErr := reader.ReadString('\n')
		if readErr != nil {
			t.Fatalf("read reply: %v", readErr)
		}
		return strings.TrimRight(line, "\r\n")
	}
	send := func(line string) {
		_, _ = writer.WriteString(line + "\r\n") //nolint:errcheck // the test client writes
		_ = writer.Flush()                       //nolint:errcheck // the test client writes
	}
	_ = read()
	send("DATA")
	if reply := read(); !strings.HasPrefix(reply, "503") {
		t.Fatalf("DATA before RCPT = %q", reply)
	}
	send("MAIL FROM:sender@example.test")
	if reply := read(); !strings.HasPrefix(reply, "501") {
		t.Fatalf("MAIL without a path = %q", reply)
	}
	send("RCPT TO:<member@example.test>")
	if reply := read(); !strings.HasPrefix(reply, "503") {
		t.Fatalf("RCPT before MAIL = %q", reply)
	}
	send("MAIL FROM:<sender@example.test>")
	_ = read()
	send("RCPT TO:member@example.test")
	if reply := read(); !strings.HasPrefix(reply, "501") {
		t.Fatalf("RCPT without a path = %q", reply)
	}
	send("QUIT")
	_ = read()
	_, _, _, count := sink.snapshot()
	if count != 0 {
		t.Fatalf("a refused conversation stored %d messages", count)
	}
}

func TestSMTPRefusesARecipientNoRuleAccepts(t *testing.T) {
	sink := startMailSinkRecorder(t)
	spec := &Spec{ReceiptRules: []ReceiptRuleSpec{{
		LogicalID:  "MailRule",
		Enabled:    true,
		Recipients: []string{"member@example.test"},
		Actions:    []ReceiptAction{{Kind: receiptActionLambda, Function: "Missing"}},
	}}}
	runner := smtpTestRunner(sink, spec)
	address, _ := startSMTPTestServer(t, runner)
	replies := smtpConversation(t, address, nil)
	joined := strings.Join(replies, "\n")
	if !strings.Contains(joined, "550 ") {
		t.Fatalf("a matching rule whose function is not running must refuse: %v", replies)
	}
	if _, _, _, count := sink.snapshot(); count != 0 {
		t.Fatalf("a refused message reached the sink %d time(s)", count)
	}
}

func TestMailServerTLSConfig(t *testing.T) {
	runner := &Runner{}
	if runner.mailServerTLSConfig() != nil {
		t.Fatal("a run without a mail leaf has no STARTTLS")
	}
	runner.mail = &mailSurface{leaf: &tls.Certificate{}}
	if runner.mailServerTLSConfig() == nil {
		t.Fatal("a mail leaf must enable STARTTLS")
	}
}
