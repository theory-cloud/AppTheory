package localrunner

import (
	"bufio"
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"time"
)

// The SMTP ingress.
//
// SES receives mail over SMTP and runs the receipt rules it derives from the
// template. The local ingress does the same two things on one connection: it
// accepts the envelope and message, hands the message to the run's receipt
// rules (which invoke the rule's Lambda action with SES's received-message
// record), and relays the same message to the sink's SMTP port so the read API
// can show it. A recipient no rule accepts is refused with a 550, which is what
// SES does when the rule set does not match.
//
// https://docs.aws.amazon.com/ses/latest/dg/receiving-email.html
// https://docs.aws.amazon.com/ses/latest/dg/receiving-email-action-lambda-event.html

// serveSMTP accepts connections until the listener closes.
func (r *Runner) serveSMTP(ctx context.Context, listener net.Listener) {
	for {
		connection, err := listener.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return
			}
			r.logf("local mail SMTP: accept failed: %v", err)
			return
		}
		go r.handleSMTP(ctx, connection)
	}
}

// smtpSession is one SMTP connection's state.
type smtpSession struct {
	runner     *Runner
	conn       net.Conn
	reader     *bufio.Reader
	writer     *bufio.Writer
	from       string
	recipients []string
	tlsActive  bool
	tlsConfig  *tls.Config
	host       string
}

// handleSMTP runs one SMTP conversation.
//
//nolint:gocognit,gocyclo // one branch per SMTP command.
func (r *Runner) handleSMTP(ctx context.Context, connection net.Conn) {
	defer func() { _ = connection.Close() }() //nolint:errcheck // the connection is done
	_ = connection.SetDeadline(time.Now().Add(mailSessionTimeout))
	session := &smtpSession{
		runner:    r,
		conn:      connection,
		reader:    bufio.NewReader(connection),
		writer:    bufio.NewWriter(connection),
		host:      mailDefaultHost,
		tlsConfig: r.mailServerTLSConfig(),
	}
	if r.mail != nil {
		session.host = r.mail.host
	}
	session.reply("220 %s ESMTP apptheory-local", session.host)
	for {
		line, err := session.reader.ReadString('\n')
		if err != nil {
			return
		}
		line = strings.TrimRight(line, "\r\n")
		if len(line) > 998 {
			session.reply("500 5.5.2 line too long")
			continue
		}
		verb, argument := "", ""
		if index := strings.IndexByte(line, ' '); index >= 0 {
			verb, argument = strings.ToUpper(line[:index]), strings.TrimSpace(line[index+1:])
		} else {
			verb = strings.ToUpper(line)
		}
		switch verb {
		case "EHLO":
			session.reset()
			session.reply("250-%s", session.host)
			session.reply("250-SIZE %d", mailMaxMessageBytes)
			session.reply("250-8BITMIME")
			if session.tlsConfig != nil && !session.tlsActive {
				session.reply("250-STARTTLS")
			}
			session.reply("250 OK")
		case "HELO":
			session.reset()
			session.reply("250 %s", session.host)
		case "STARTTLS":
			if session.tlsActive || session.tlsConfig == nil {
				session.reply("502 5.5.1 STARTTLS is not available")
				continue
			}
			session.reply("220 2.0.0 Ready to start TLS")
			tlsConn := tls.Server(session.conn, session.tlsConfig)
			if handshakeErr := tlsConn.HandshakeContext(ctx); handshakeErr != nil {
				r.logf("local mail SMTP: STARTTLS handshake failed: %v", handshakeErr)
				return
			}
			session.conn = tlsConn
			session.reader = bufio.NewReader(tlsConn)
			session.writer = bufio.NewWriter(tlsConn)
			session.tlsActive = true
			session.reset()
		case "MAIL":
			address, ok := smtpPath(argument, "FROM:")
			if !ok {
				session.reply("501 5.5.2 a MAIL FROM address is required")
				continue
			}
			session.reset()
			session.from = address
			session.reply("250 2.1.0 Ok")
		case "RCPT":
			if session.from == "" && len(session.recipients) == 0 {
				session.reply("503 5.5.1 MAIL FROM first")
				continue
			}
			address, ok := smtpPath(argument, "TO:")
			if !ok {
				session.reply("501 5.5.2 a RCPT TO address is required")
				continue
			}
			session.recipients = append(session.recipients, address)
			session.reply("250 2.1.5 Ok")
		case "DATA":
			session.receiveData(ctx)
		case "RSET":
			session.reset()
			session.reply("250 2.0.0 Ok")
		case "NOOP":
			session.reply("250 2.0.0 Ok")
		case "QUIT":
			session.reply("221 2.0.0 Bye")
			return
		case "AUTH":
			session.reply("502 5.5.1 authentication is not configured on the local sink")
		default:
			session.reply("502 5.5.2 command not recognized")
		}
	}
}

// receiveData reads one message and delivers it.
func (s *smtpSession) receiveData(ctx context.Context) {
	if len(s.recipients) == 0 {
		s.reply("503 5.5.1 RCPT TO first")
		return
	}
	s.reply("354 End data with <CR><LF>.<CR><LF>")
	raw, err := s.readMessage()
	if err != nil {
		s.reply("552 5.3.4 %s", smtpReason(err))
		s.reset()
		return
	}
	code, deliverErr := s.deliver(ctx, raw)
	if deliverErr != nil {
		s.reply("%d %s", code, smtpReason(deliverErr))
		s.reset()
		return
	}
	s.reply("250 2.0.0 Ok: queued")
	s.reset()
}

// readMessage reads the DATA body until the terminating dot and normalizes it
// to CRLF line endings.
func (s *smtpSession) readMessage() (string, error) {
	var builder strings.Builder
	for {
		line, err := s.reader.ReadString('\n')
		if err != nil {
			if errors.Is(err, io.EOF) {
				return "", errors.New("the connection ended inside DATA")
			}
			return "", err
		}
		if builder.Len()+len(line) > mailMaxMessageBytes {
			return "", fmt.Errorf("the message exceeds %d bytes", mailMaxMessageBytes)
		}
		if line == ".\r\n" || line == ".\n" {
			break
		}
		line = strings.TrimPrefix(line, ".")
		builder.WriteString(line)
	}
	return normalizeCRLF(builder.String()), nil
}

// deliver hands one message to the receipt rules and then to the sink.
func (s *smtpSession) deliver(ctx context.Context, raw string) (int, error) {
	spec := s.runner.CurrentSpec()
	if spec == nil {
		return 451, errors.New("the run has no derived surface yet")
	}
	// A recipient the template's rule set accepts runs SES's actions. Any
	// other recipient is outbound mail the sink stores: the one SMTP ingress is
	// both SES's receive path and the app's Migadu-shaped outbound sink, and an
	// app sends outbound mail to addresses its own rule set never matches.
	if matching := receiptRulesFor(spec.ReceiptRules, s.recipients[0]); len(matching) > 0 {
		if _, err := s.runner.receiveMessage(ctx, spec, receivedMessage{
			Source:     s.from,
			Recipients: s.recipients,
			Raw:        raw,
		}); err != nil {
			return 550, err
		}
	}
	if s.runner.mail == nil {
		return 451, errors.New("the local mail sink is not ready")
	}
	if err := relaySMTP(ctx, s.runner.mail.relayAddr, s.from, s.recipients, raw); err != nil {
		return 451, fmt.Errorf("relay to the local mail sink failed: %w", err)
	}
	return 250, nil
}

func (s *smtpSession) reset() {
	s.from = ""
	s.recipients = nil
}

func (s *smtpSession) reply(format string, args ...any) {
	_, _ = fmt.Fprintf(s.writer, format+"\r\n", args...) //nolint:errcheck // the SMTP reply is best effort
	_ = s.writer.Flush()                                 //nolint:errcheck // the SMTP reply is best effort
}

// mailServerTLSConfig is the STARTTLS configuration of the mail ingress.
func (r *Runner) mailServerTLSConfig() *tls.Config {
	if r.mail == nil || r.mail.leaf == nil {
		return nil
	}
	return &tls.Config{
		MinVersion:   tls.VersionTLS12,
		Certificates: []tls.Certificate{*r.mail.leaf},
	}
}

// relaySMTP delivers one message to the sink's SMTP port over a real SMTP
// conversation.
//
//nolint:gocyclo // one explicit step per SMTP command and reply.
func relaySMTP(ctx context.Context, address, from string, recipients []string, raw string) error {
	dialer := &net.Dialer{Timeout: 5 * time.Second}
	connection, err := dialer.DialContext(ctx, "tcp", address)
	if err != nil {
		return err
	}
	defer func() { _ = connection.Close() }() //nolint:errcheck // the message is delivered or the error is returned
	_ = connection.SetDeadline(time.Now().Add(mailSessionTimeout))
	reader := bufio.NewReader(connection)
	writer := bufio.NewWriter(connection)
	reply := func(format string, args ...any) error {
		if _, err := fmt.Fprintf(writer, format+"\r\n", args...); err != nil {
			return err
		}
		return writer.Flush()
	}
	if code, _, err := readSMTPReply(reader); err != nil || code/100 != 2 {
		return fmt.Errorf("the sink refused the greeting (%d): %v", code, err)
	}
	if err := reply("EHLO apptheory-local"); err != nil {
		return err
	}
	if code, text, err := readSMTPReply(reader); err != nil || code/100 != 2 {
		return fmt.Errorf("the sink refused EHLO (%d %s): %v", code, text, err)
	}
	if err := reply("MAIL FROM:<%s>", from); err != nil {
		return err
	}
	if code, text, err := readSMTPReply(reader); err != nil || code/100 != 2 {
		return fmt.Errorf("the sink refused MAIL FROM (%d %s): %v", code, text, err)
	}
	for _, recipient := range recipients {
		if err := reply("RCPT TO:<%s>", recipient); err != nil {
			return err
		}
		if code, text, err := readSMTPReply(reader); err != nil || code/100 != 2 {
			return fmt.Errorf("the sink refused RCPT TO <%s> (%d %s): %v", recipient, code, text, err)
		}
	}
	if err := reply("DATA"); err != nil {
		return err
	}
	if code, text, err := readSMTPReply(reader); err != nil || code != 354 {
		return fmt.Errorf("the sink refused DATA (%d %s): %v", code, text, err)
	}
	for _, line := range strings.Split(strings.TrimSuffix(normalizeCRLF(raw), "\r\n"), "\r\n") {
		if strings.HasPrefix(line, ".") {
			line = "." + line
		}
		if _, err := fmt.Fprintf(writer, "%s\r\n", line); err != nil {
			return err
		}
	}
	if err := reply("."); err != nil {
		return err
	}
	if code, text, err := readSMTPReply(reader); err != nil || code/100 != 2 {
		return fmt.Errorf("the sink refused the message (%d %s): %v", code, text, err)
	}
	_ = reply("QUIT") //nolint:errcheck // the message is already accepted
	return nil
}

// readSMTPReply reads one (possibly multi-line) SMTP reply.
func readSMTPReply(reader *bufio.Reader) (int, string, error) {
	var code int
	var text strings.Builder
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			return 0, "", err
		}
		line = strings.TrimRight(line, "\r\n")
		if len(line) < 3 {
			return 0, "", fmt.Errorf("malformed SMTP reply %q", line)
		}
		parsed := 0
		for _, char := range line[:3] {
			if char < '0' || char > '9' {
				return 0, "", fmt.Errorf("malformed SMTP reply %q", line)
			}
			parsed = parsed*10 + int(char-'0')
		}
		code = parsed
		if len(line) > 4 {
			text.WriteString(line[4:])
		}
		if len(line) == 3 || line[3] == ' ' {
			return code, text.String(), nil
		}
	}
}

// smtpPath parses "FROM:<addr>" or "TO:<addr>".
func smtpPath(argument, prefix string) (string, bool) {
	if !strings.HasPrefix(strings.ToUpper(argument), prefix) {
		return "", false
	}
	rest := strings.TrimSpace(argument[len(prefix):])
	if rest == "<>" {
		return "", true
	}
	if !strings.HasPrefix(rest, "<") {
		return "", false
	}
	end := strings.IndexByte(rest, '>')
	if end < 0 || end == 1 {
		return "", false
	}
	return rest[1:end], true
}

// normalizeCRLF gives a message canonical CRLF line endings.
func normalizeCRLF(raw string) string {
	normalized := strings.ReplaceAll(raw, "\r\n", "\n")
	normalized = strings.ReplaceAll(normalized, "\r", "\n")
	return strings.ReplaceAll(normalized, "\n", "\r\n")
}

// smtpReason renders an error as one SMTP reply line.
func smtpReason(err error) string {
	reason := strings.ReplaceAll(err.Error(), "\r", " ")
	return strings.ReplaceAll(reason, "\n", " ")
}
