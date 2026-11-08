package localrunner

import (
	"context"
	"fmt"
)

// sesReceive injects one received message and delivers it to every matching
// receipt rule.
//
// https://docs.aws.amazon.com/ses/latest/dg/receiving-email.html
func (s *localSession) sesReceive(ctx context.Context, request sessionRequest) (any, error) {
	delivery, err := s.receiveMessage(ctx, receivedMessage{
		Source:     request.Source,
		Recipients: request.Recipients,
		Raw:        request.RawMessage,
		MessageID:  request.MessageID,
	})
	if err != nil {
		return nil, err
	}
	return delivery, nil
}

// customResourceDeleteOp runs one custom resource's Delete handler.
func (s *localSession) customResourceDeleteOp(ctx context.Context, request sessionRequest) (any, error) {
	if request.Resource == "" {
		return nil, fmt.Errorf("customResource.delete needs the resource logical id")
	}
	return s.runner.customResourceDelete(ctx, s.spec, request.Resource)
}
