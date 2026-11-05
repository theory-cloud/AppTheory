'use strict';

// Lambda@Edge origin-request.
//
// It runs only when CloudFront forwards the request to the origin. For
// /edge/generated it returns a response with an invocation counter held in the
// module scope: the gateway caches that response, so a second viewer request is
// served from the cache without invoking this function again. For
// /edge/to-api it rewrites the origin to another origin the assembly declares.
let invocations = 0;

exports.handler = async (event) => {
    const cf = event.Records[0].cf;
    const request = cf.request;

    if (request.uri === '/edge/generated') {
        invocations += 1;
        return {
            status: '200',
            statusDescription: 'OK',
            headers: {
                'content-type': [{ key: 'Content-Type', value: 'application/json' }],
                'cache-control': [{ key: 'Cache-Control', value: 'max-age=120' }],
                'x-edge-invocations': [{ key: 'X-Edge-Invocations', value: String(invocations) }],
            },
            body: JSON.stringify({
                generated: true,
                invocations,
                originKind: request.origin && request.origin.s3 ? 's3' : 'custom',
            }),
        };
    }

    if (request.uri === '/edge/to-api') {
        request.origin = {
            custom: {
                domainName: 'api.example.com',
                path: '',
                port: 80,
                protocol: 'http',
                customHeaders: {},
            },
        };
    }

    if (request.body && request.body.data) {
        request.headers['x-edge-origin-body-length'] = [{
            key: 'X-Edge-Origin-Body-Length',
            value: String(Buffer.from(request.body.data, 'base64').length),
        }];
    }

    return request;
};
