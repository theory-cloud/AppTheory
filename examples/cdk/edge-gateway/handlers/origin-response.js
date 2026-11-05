'use strict';

// Lambda@Edge origin-response.
//
// It runs after CloudFront receives a response from the origin, even for an
// error status, and before the object is cached. It does not see the origin
// body; it may replace it.
exports.handler = async (event) => {
    const cf = event.Records[0].cf;
    const response = cf.response;

    response.headers['x-lambda-edge-origin-response'] = [{ key: 'X-Lambda-Edge-Origin-Response', value: 'seen' }];

    if (cf.request.uri === '/edge/body') {
        response.body = {
            action: 'replace',
            encoding: 'text',
            data: 'replaced by the origin-response function',
        };
    }

    return response;
};
