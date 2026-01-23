import { Buffer } from "node:buffer";
import { RealClock } from "./clock.js";
import { Context, EventContext, WebSocketContext } from "./context.js";
import { AppError } from "./errors.js";
import { RandomIdGenerator } from "./ids.js";
import { albTargetGroupResponseFromResponse, apigatewayProxyResponseFromResponse, apigatewayV2ResponseFromResponse, lambdaFunctionURLResponseFromResponse, requestFromALBTargetGroup, requestFromAPIGatewayProxy, requestFromAPIGatewayV2, requestFromLambdaFunctionURL, requestFromWebSocketEvent, } from "./internal/aws-http.js";
import { serveLambdaFunctionURLStreaming, } from "./internal/aws-lambda-streaming.js";
import { dynamoDBTableNameFromStreamArn, eventBridgeRuleNameFromArn, kinesisStreamNameFromArn, snsTopicNameFromArn, sqsQueueNameFromArn, webSocketManagementEndpoint, } from "./internal/aws-names.js";
import { canonicalizeHeaders, cloneQuery, firstHeaderValue, normalizeMethod, normalizePath, } from "./internal/http.js";
import { normalizeRequest } from "./internal/request.js";
import { errorResponse, errorResponseWithRequestId, normalizeResponse, responseForError, responseForErrorWithRequestId, } from "./internal/response.js";
import { Router } from "./internal/router.js";
import { vary } from "./response.js";
import { WebSocketManagementClient } from "./websocket-management.js";
export class App {
    _router;
    _clock;
    _ids;
    _tier;
    _limits;
    _cors;
    _authHook;
    _policyHook;
    _observability;
    _webSocketRoutes;
    _webSocketClientFactory;
    _sqsRoutes;
    _kinesisRoutes;
    _snsRoutes;
    _eventBridgeRoutes;
    _dynamoDBRoutes;
    _middlewares;
    _eventMiddlewares;
    constructor(options = {}) {
        this._router = new Router();
        this._clock = options.clock ?? new RealClock();
        this._ids = options.ids ?? new RandomIdGenerator();
        this._tier =
            options.tier === "p0" || options.tier === "p1" || options.tier === "p2"
                ? options.tier
                : "p2";
        this._limits = {
            maxRequestBytes: Number(options.limits?.maxRequestBytes ?? 0),
            maxResponseBytes: Number(options.limits?.maxResponseBytes ?? 0),
        };
        this._cors = normalizeCorsConfig(options.cors);
        this._authHook = options.authHook ?? null;
        this._policyHook = options.policyHook ?? null;
        this._observability = options.observability ?? null;
        this._webSocketRoutes = [];
        this._webSocketClientFactory =
            typeof options.webSocketClientFactory === "function"
                ? options.webSocketClientFactory
                : (endpoint) => new WebSocketManagementClient({ endpoint });
        this._sqsRoutes = [];
        this._kinesisRoutes = [];
        this._snsRoutes = [];
        this._eventBridgeRoutes = [];
        this._dynamoDBRoutes = [];
        this._middlewares = [];
        this._eventMiddlewares = [];
    }
    handle(method, pattern, handler, options = {}) {
        this._router.add(method, pattern, handler, options);
        return this;
    }
    handleStrict(method, pattern, handler, options = {}) {
        this._router.addStrict(method, pattern, handler, options);
        return this;
    }
    get(pattern, handler) {
        return this.handle("GET", pattern, handler);
    }
    post(pattern, handler) {
        return this.handle("POST", pattern, handler);
    }
    put(pattern, handler) {
        return this.handle("PUT", pattern, handler);
    }
    patch(pattern, handler) {
        return this.handle("PATCH", pattern, handler);
    }
    options(pattern, handler) {
        return this.handle("OPTIONS", pattern, handler);
    }
    delete(pattern, handler) {
        return this.handle("DELETE", pattern, handler);
    }
    use(middleware) {
        if (typeof middleware !== "function")
            return this;
        this._middlewares.push(middleware);
        return this;
    }
    useEvents(middleware) {
        if (typeof middleware !== "function")
            return this;
        this._eventMiddlewares.push(middleware);
        return this;
    }
    _applyMiddlewares(handler) {
        if (typeof handler !== "function" || this._middlewares.length === 0) {
            return handler;
        }
        let wrapped = handler;
        for (let i = this._middlewares.length - 1; i >= 0; i -= 1) {
            const mw = this._middlewares[i];
            if (typeof mw !== "function")
                continue;
            const next = wrapped;
            wrapped = async (ctx) => mw(ctx, next);
        }
        return wrapped;
    }
    _applyEventMiddlewares(handler) {
        if (typeof handler !== "function" || this._eventMiddlewares.length === 0) {
            return handler ? async (ctx, event) => handler(ctx, event) : null;
        }
        let wrapped = async (ctx, event) => handler(ctx, event);
        for (let i = this._eventMiddlewares.length - 1; i >= 0; i -= 1) {
            const mw = this._eventMiddlewares[i];
            if (typeof mw !== "function")
                continue;
            const next = wrapped;
            wrapped = async (ctx, event) => mw(ctx, event, async () => next(ctx, event));
        }
        return wrapped;
    }
    webSocket(routeKey, handler) {
        const key = String(routeKey ?? "").trim();
        if (!key || typeof handler !== "function")
            return this;
        this._webSocketRoutes.push({ routeKey: key, handler });
        return this;
    }
    sqs(queueName, handler) {
        const name = String(queueName ?? "").trim();
        if (!name || typeof handler !== "function")
            return this;
        this._sqsRoutes.push({ queueName: name, handler });
        return this;
    }
    kinesis(streamName, handler) {
        const name = String(streamName ?? "").trim();
        if (!name || typeof handler !== "function")
            return this;
        this._kinesisRoutes.push({ streamName: name, handler });
        return this;
    }
    sns(topicName, handler) {
        const name = String(topicName ?? "").trim();
        if (!name || typeof handler !== "function")
            return this;
        this._snsRoutes.push({ topicName: name, handler });
        return this;
    }
    eventBridge(selector, handler) {
        if (typeof handler !== "function")
            return this;
        const sel = {
            ruleName: String(selector?.ruleName ?? "").trim(),
            source: String(selector?.source ?? "").trim(),
            detailType: String(selector?.detailType ?? "").trim(),
        };
        if (!sel.ruleName && !sel.source && !sel.detailType)
            return this;
        this._eventBridgeRoutes.push({ selector: sel, handler });
        return this;
    }
    dynamoDB(tableName, handler) {
        const name = String(tableName ?? "").trim();
        if (!name || typeof handler !== "function")
            return this;
        this._dynamoDBRoutes.push({ tableName: name, handler });
        return this;
    }
    async serve(request, ctx) {
        if (this._tier === "p0") {
            let normalized;
            try {
                normalized = normalizeRequest(request);
            }
            catch (err) {
                return responseForError(err);
            }
            const { match, allowed } = this._router.match(normalized.method, normalized.path);
            if (!match) {
                if (allowed.length > 0) {
                    return errorResponse("app.method_not_allowed", "method not allowed", {
                        allow: [formatAllowHeader(allowed)],
                    });
                }
                return errorResponse("app.not_found", "not found");
            }
            const requestCtx = new Context({
                request: normalized,
                params: match.params,
                clock: this._clock,
                ids: this._ids,
                ctx,
            });
            try {
                const handler = this._applyMiddlewares(match.route.handler);
                const out = await handler(requestCtx);
                return normalizeResponse(out);
            }
            catch (err) {
                return responseForError(err);
            }
        }
        const preHeaders = canonicalizeHeaders(request.headers);
        const preQuery = cloneQuery(request.query);
        let method = normalizeMethod(request.method);
        let path = normalizePath(request.path);
        let requestId = firstHeaderValue(preHeaders, "x-request-id");
        if (!requestId) {
            requestId = this._ids.newId();
        }
        const origin = firstHeaderValue(preHeaders, "origin");
        const middlewareTrace = ["request_id", "recovery", "logging"];
        if (origin)
            middlewareTrace.push("cors");
        const tenantId = extractTenantId(preHeaders, preQuery);
        const remainingMs = extractRemainingMs(ctx);
        const enableP2 = this._tier === "p2";
        const finish = (resp, errCode) => {
            const out = finalizeP1Response(resp, requestId, origin, this._cors);
            if (enableP2) {
                recordObservability(this._observability, {
                    method,
                    path,
                    requestId,
                    tenantId,
                    status: out.status,
                    errorCode: errCode ?? "",
                });
            }
            return out;
        };
        if (isCorsPreflight(method, preHeaders)) {
            const allow = firstHeaderValue(preHeaders, "access-control-request-method");
            const resp = normalizeResponse({
                status: 204,
                headers: { "access-control-allow-methods": [allow] },
                cookies: [],
                body: Buffer.alloc(0),
                isBase64: false,
            });
            return finish(resp, "");
        }
        let normalized;
        try {
            normalized = normalizeRequest(request);
        }
        catch (err) {
            const code = err instanceof AppError ? err.code : "app.internal";
            return finish(responseForErrorWithRequestId(err, requestId), code);
        }
        method = normalized.method;
        path = normalized.path;
        if (this._limits.maxRequestBytes > 0 &&
            Buffer.from(normalized.body).length > this._limits.maxRequestBytes) {
            return finish(errorResponseWithRequestId("app.too_large", "request too large", {}, requestId), "app.too_large");
        }
        const { match, allowed } = this._router.match(normalized.method, normalized.path);
        if (!match) {
            if (allowed.length > 0) {
                return finish(errorResponseWithRequestId("app.method_not_allowed", "method not allowed", { allow: [formatAllowHeader(allowed)] }, requestId), "app.method_not_allowed");
            }
            return finish(errorResponseWithRequestId("app.not_found", "not found", {}, requestId), "app.not_found");
        }
        const requestCtx = new Context({
            request: normalized,
            params: match.params,
            clock: this._clock,
            ids: this._ids,
            ctx,
            requestId,
            tenantId,
            authIdentity: "",
            remainingMs,
            middlewareTrace,
        });
        if (enableP2 && typeof this._policyHook === "function") {
            let decision;
            try {
                decision = await this._policyHook(requestCtx);
            }
            catch (err) {
                const code = err instanceof AppError ? err.code : "app.internal";
                return finish(responseForErrorWithRequestId(err, requestId), code);
            }
            const code = String(decision?.code ?? "").trim();
            if (code) {
                const message = String(decision?.message ?? "").trim() || defaultPolicyMessage(code);
                return finish(errorResponseWithRequestId(code, message, decision?.headers ?? {}, requestId), code);
            }
        }
        if (match.route.authRequired) {
            middlewareTrace.push("auth");
            try {
                if (!this._authHook) {
                    throw new AppError("app.unauthorized", "unauthorized");
                }
                const identity = await this._authHook(requestCtx);
                if (!String(identity ?? "").trim()) {
                    throw new AppError("app.unauthorized", "unauthorized");
                }
                requestCtx.authIdentity = String(identity);
            }
            catch (err) {
                const code = err instanceof AppError ? err.code : "app.internal";
                return finish(responseForErrorWithRequestId(err, requestId), code);
            }
        }
        middlewareTrace.push("handler");
        let out;
        try {
            const handler = this._applyMiddlewares(match.route.handler);
            out = await handler(requestCtx);
        }
        catch (err) {
            const code = err instanceof AppError ? err.code : "app.internal";
            return finish(responseForErrorWithRequestId(err, requestId), code);
        }
        if (!out) {
            return finish(errorResponseWithRequestId("app.internal", "internal error", {}, requestId), "app.internal");
        }
        let resp;
        try {
            resp = normalizeResponse(out);
        }
        catch (err) {
            const code = err instanceof AppError ? err.code : "app.internal";
            return finish(responseForErrorWithRequestId(err, requestId), code);
        }
        if (this._limits.maxResponseBytes > 0 &&
            Buffer.from(resp.body).length > this._limits.maxResponseBytes) {
            return finish(errorResponseWithRequestId("app.too_large", "response too large", {}, requestId), "app.too_large");
        }
        return finish(resp, "");
    }
    async serveAPIGatewayV2(event, ctx) {
        let request;
        try {
            request = requestFromAPIGatewayV2(event);
        }
        catch (err) {
            return apigatewayV2ResponseFromResponse(responseForError(err));
        }
        const resp = await this.serve(request, ctx);
        return apigatewayV2ResponseFromResponse(resp);
    }
    async serveLambdaFunctionURL(event, ctx) {
        let request;
        try {
            request = requestFromLambdaFunctionURL(event);
        }
        catch (err) {
            return lambdaFunctionURLResponseFromResponse(responseForError(err));
        }
        const resp = await this.serve(request, ctx);
        return lambdaFunctionURLResponseFromResponse(resp);
    }
    async serveAPIGatewayProxy(event, ctx) {
        let request;
        try {
            request = requestFromAPIGatewayProxy(event);
        }
        catch (err) {
            return apigatewayProxyResponseFromResponse(responseForError(err));
        }
        const resp = await this.serve(request, ctx);
        return apigatewayProxyResponseFromResponse(resp);
    }
    async serveALB(event, ctx) {
        let request;
        try {
            request = requestFromALBTargetGroup(event);
        }
        catch (err) {
            return albTargetGroupResponseFromResponse(responseForError(err));
        }
        const resp = await this.serve(request, ctx);
        return albTargetGroupResponseFromResponse(resp);
    }
    _webSocketHandlerForEvent(event) {
        const routeKey = String(event?.requestContext?.routeKey ?? "").trim();
        if (!routeKey)
            return null;
        for (const route of this._webSocketRoutes) {
            if (route.routeKey === routeKey)
                return route.handler;
        }
        return null;
    }
    async serveWebSocket(event, ctx) {
        const handler = this._applyMiddlewares(this._webSocketHandlerForEvent(event));
        let requestId = String(event?.requestContext?.requestId ?? "").trim();
        if (!requestId) {
            const awsRequestId = ctx &&
                typeof ctx === "object" &&
                typeof ctx["awsRequestId"] === "string"
                ? String(ctx["awsRequestId"]).trim()
                : "";
            requestId = awsRequestId || this._ids.newId();
        }
        let request;
        try {
            request = requestFromWebSocketEvent(event);
        }
        catch (err) {
            if (this._tier === "p0") {
                return apigatewayProxyResponseFromResponse(responseForError(err));
            }
            return apigatewayProxyResponseFromResponse(responseForErrorWithRequestId(err, requestId));
        }
        const domainName = String(event?.requestContext?.domainName ?? "").trim();
        const stage = String(event?.requestContext?.stage ?? "").trim();
        const wsCtx = new WebSocketContext({
            clock: this._clock,
            ids: this._ids,
            ctx,
            requestId,
            remainingMs: extractRemainingMs(ctx),
            connectionId: String(event?.requestContext?.connectionId ?? "").trim(),
            routeKey: String(event?.requestContext?.routeKey ?? "").trim(),
            domainName,
            stage,
            eventType: String(event?.requestContext?.eventType ?? "").trim(),
            managementEndpoint: webSocketManagementEndpoint(domainName, stage),
            body: request.body,
            clientFactory: this._webSocketClientFactory,
        });
        const requestCtx = new Context({
            request,
            params: {},
            clock: this._clock,
            ids: this._ids,
            ctx,
            requestId,
            tenantId: extractTenantId(request.headers, request.query),
            authIdentity: "",
            remainingMs: extractRemainingMs(ctx),
            middlewareTrace: [],
            webSocket: wsCtx,
        });
        if (!handler) {
            if (this._tier === "p0") {
                return apigatewayProxyResponseFromResponse(errorResponse("app.not_found", "not found"));
            }
            return apigatewayProxyResponseFromResponse(errorResponseWithRequestId("app.not_found", "not found", {}, requestId));
        }
        let resp;
        try {
            resp = await handler(requestCtx);
        }
        catch (err) {
            if (this._tier === "p0") {
                return apigatewayProxyResponseFromResponse(responseForError(err));
            }
            return apigatewayProxyResponseFromResponse(responseForErrorWithRequestId(err, requestId));
        }
        if (!resp) {
            if (this._tier === "p0") {
                return apigatewayProxyResponseFromResponse(errorResponse("app.internal", "internal error"));
            }
            return apigatewayProxyResponseFromResponse(errorResponseWithRequestId("app.internal", "internal error", {}, requestId));
        }
        return apigatewayProxyResponseFromResponse(normalizeResponse(resp));
    }
    _eventContext(ctx) {
        const requestId = ctx &&
            typeof ctx === "object" &&
            typeof ctx["awsRequestId"] === "string" &&
            String(ctx["awsRequestId"]).trim()
            ? String(ctx["awsRequestId"]).trim()
            : this._ids.newId();
        return new EventContext({
            clock: this._clock,
            ids: this._ids,
            ctx,
            requestId,
            remainingMs: extractRemainingMs(ctx),
        });
    }
    _sqsHandlerForEvent(event) {
        const records = Array.isArray(event?.Records) ? event.Records : [];
        if (records.length === 0)
            return null;
        const queueName = sqsQueueNameFromArn(String(records[0]?.eventSourceARN ?? ""));
        if (!queueName)
            return null;
        for (const route of this._sqsRoutes) {
            if (route.queueName === queueName)
                return route.handler;
        }
        return null;
    }
    async serveSQSEvent(event, ctx) {
        const records = Array.isArray(event?.Records) ? event.Records : [];
        const handler = this._sqsHandlerForEvent(event);
        if (!handler) {
            const failures = records
                .map((r) => String(r?.messageId ?? "").trim())
                .filter(Boolean)
                .map((id) => ({ itemIdentifier: id }));
            return { batchItemFailures: failures };
        }
        const eventCtx = this._eventContext(ctx);
        let failures = [];
        const wrapped = this._applyEventMiddlewares(handler);
        for (const record of records) {
            let recordError = null;
            try {
                await (wrapped ?? handler)(eventCtx, record);
            }
            catch (err) {
                recordError = err;
            }
            if (recordError) {
                failures.push({
                    itemIdentifier: String(record?.messageId ?? ""),
                });
            }
        }
        failures = failures.filter((f) => f.itemIdentifier);
        return { batchItemFailures: failures };
    }
    _kinesisHandlerForEvent(event) {
        const records = Array.isArray(event?.Records) ? event.Records : [];
        if (records.length === 0)
            return null;
        const streamName = kinesisStreamNameFromArn(String(records[0]?.eventSourceARN ?? ""));
        if (!streamName)
            return null;
        for (const route of this._kinesisRoutes) {
            if (route.streamName === streamName)
                return route.handler;
        }
        return null;
    }
    async serveKinesisEvent(event, ctx) {
        const records = Array.isArray(event?.Records) ? event.Records : [];
        const handler = this._kinesisHandlerForEvent(event);
        if (!handler) {
            const failures = records
                .map((r) => String(r?.eventID ?? "").trim())
                .filter(Boolean)
                .map((id) => ({ itemIdentifier: id }));
            return { batchItemFailures: failures };
        }
        const eventCtx = this._eventContext(ctx);
        let failures = [];
        const wrapped = this._applyEventMiddlewares(handler);
        for (const record of records) {
            let recordError = null;
            try {
                await (wrapped ?? handler)(eventCtx, record);
            }
            catch (err) {
                recordError = err;
            }
            if (recordError) {
                failures.push({
                    itemIdentifier: String(record?.eventID ?? ""),
                });
            }
        }
        failures = failures.filter((f) => f.itemIdentifier);
        return { batchItemFailures: failures };
    }
    _snsHandlerForEvent(event) {
        const records = Array.isArray(event?.Records) ? event.Records : [];
        if (records.length === 0)
            return null;
        const topicArn = String(records[0]?.Sns?.TopicArn ?? "").trim();
        const topicName = snsTopicNameFromArn(topicArn);
        if (!topicName)
            return null;
        for (const route of this._snsRoutes) {
            if (route.topicName === topicName)
                return route.handler;
        }
        return null;
    }
    async serveSNSEvent(event, ctx) {
        const records = Array.isArray(event?.Records) ? event.Records : [];
        const handler = this._snsHandlerForEvent(event);
        if (!handler) {
            throw new Error("apptheory: unrecognized sns topic");
        }
        const eventCtx = this._eventContext(ctx);
        const out = [];
        const wrapped = this._applyEventMiddlewares(handler);
        for (const record of records) {
            out.push(await (wrapped ?? handler)(eventCtx, record));
        }
        return out;
    }
    _eventBridgeHandlerForEvent(event) {
        const resources = Array.isArray(event?.resources) ? event.resources : [];
        const source = String(event?.source ?? "").trim();
        const detailType = String(event["detail-type"] ??
            event?.detailType ??
            "").trim();
        if (resources.length === 0 && !source && !detailType)
            return null;
        for (const route of this._eventBridgeRoutes) {
            const sel = route.selector ?? {};
            if (sel.ruleName) {
                let matched = false;
                for (const resource of resources) {
                    if (eventBridgeRuleNameFromArn(resource) === sel.ruleName) {
                        matched = true;
                        break;
                    }
                }
                if (!matched)
                    continue;
                return route.handler;
            }
            if (sel.source && sel.source !== source)
                continue;
            if (sel.detailType && sel.detailType !== detailType)
                continue;
            return route.handler;
        }
        return null;
    }
    async serveEventBridge(event, ctx) {
        const handler = this._eventBridgeHandlerForEvent(event);
        if (!handler) {
            return null;
        }
        const eventCtx = this._eventContext(ctx);
        const wrapped = this._applyEventMiddlewares(handler);
        return await (wrapped ?? handler)(eventCtx, event);
    }
    _dynamoDBHandlerForEvent(event) {
        const records = Array.isArray(event?.Records) ? event.Records : [];
        if (records.length === 0)
            return null;
        const tableName = dynamoDBTableNameFromStreamArn(String(records[0]?.eventSourceARN ?? ""));
        if (!tableName)
            return null;
        for (const route of this._dynamoDBRoutes) {
            if (route.tableName === tableName)
                return route.handler;
        }
        return null;
    }
    async serveDynamoDBStream(event, ctx) {
        const records = Array.isArray(event?.Records) ? event.Records : [];
        const handler = this._dynamoDBHandlerForEvent(event);
        if (!handler) {
            const failures = records
                .map((r) => String(r?.eventID ?? "").trim())
                .filter(Boolean)
                .map((id) => ({ itemIdentifier: id }));
            return { batchItemFailures: failures };
        }
        const eventCtx = this._eventContext(ctx);
        let failures = [];
        const wrapped = this._applyEventMiddlewares(handler);
        for (const record of records) {
            let recordError = null;
            try {
                await (wrapped ?? handler)(eventCtx, record);
            }
            catch (err) {
                recordError = err;
            }
            if (recordError) {
                failures.push({
                    itemIdentifier: String(record?.eventID ?? ""),
                });
            }
        }
        failures = failures.filter((f) => f.itemIdentifier);
        return { batchItemFailures: failures };
    }
    async handleLambda(event, ctx) {
        if (!event || typeof event !== "object") {
            throw new Error("apptheory: event must be an object");
        }
        const record = event;
        const records = Array.isArray(record["Records"])
            ? record["Records"]
            : [];
        if (records.length > 0 && records[0] && typeof records[0] === "object") {
            const first = records[0];
            if ("Sns" in first) {
                return this.serveSNSEvent(event, ctx);
            }
            const src = String(first["eventSource"] ?? "").trim();
            if (src === "aws:sqs") {
                return this.serveSQSEvent(event, ctx);
            }
            if (src === "aws:kinesis") {
                return this.serveKinesisEvent(event, ctx);
            }
            if (src === "aws:dynamodb") {
                return this.serveDynamoDBStream(event, ctx);
            }
        }
        if (typeof (record["detail-type"] ?? undefined) === "string") {
            return this.serveEventBridge(event, ctx);
        }
        if (typeof record["detailType"] === "string") {
            return this.serveEventBridge(event, ctx);
        }
        if (record["requestContext"] &&
            typeof record["requestContext"] === "object") {
            const rc = record["requestContext"];
            if (typeof rc["connectionId"] === "string" &&
                String(rc["connectionId"]).trim()) {
                return this.serveWebSocket(event, ctx);
            }
            if (rc["http"] && typeof rc["http"] === "object") {
                if ("routeKey" in record) {
                    return this.serveAPIGatewayV2(event, ctx);
                }
                return this.serveLambdaFunctionURL(event, ctx);
            }
            if (rc["elb"] && typeof rc["elb"] === "object") {
                const elb = rc["elb"];
                if (typeof elb["targetGroupArn"] === "string" &&
                    String(elb["targetGroupArn"]).trim()) {
                    return this.serveALB(event, ctx);
                }
            }
            if (typeof record["httpMethod"] === "string" &&
                String(record["httpMethod"]).trim()) {
                return this.serveAPIGatewayProxy(event, ctx);
            }
        }
        throw new Error("apptheory: unknown event type");
    }
}
export function createApp(options = {}) {
    return new App(options);
}
export function createLambdaFunctionURLStreamingHandler(app) {
    const aws = globalThis.awslambda;
    if (aws && typeof aws === "object" && "streamifyResponse" in aws) {
        const streamify = aws
            .streamifyResponse;
        if (streamify) {
            return streamify((event, responseStream, ctx) => serveLambdaFunctionURLStreaming(app, event, responseStream, ctx));
        }
    }
    return async (event, ctx) => app.serveLambdaFunctionURL(event, ctx);
}
function normalizeTimeoutConfig(config) {
    let defaultTimeoutMs = Number(config?.defaultTimeoutMs ?? 0);
    if (!Number.isFinite(defaultTimeoutMs))
        defaultTimeoutMs = 0;
    defaultTimeoutMs = Math.floor(defaultTimeoutMs);
    if (defaultTimeoutMs === 0)
        defaultTimeoutMs = 30_000;
    const timeoutMessage = String(config?.timeoutMessage ?? "").trim() || "request timeout";
    const operationTimeoutsMs = config?.operationTimeoutsMs &&
        typeof config.operationTimeoutsMs === "object"
        ? config.operationTimeoutsMs
        : null;
    const tenantTimeoutsMs = config?.tenantTimeoutsMs && typeof config.tenantTimeoutsMs === "object"
        ? config.tenantTimeoutsMs
        : null;
    return {
        defaultTimeoutMs,
        operationTimeoutsMs,
        tenantTimeoutsMs,
        timeoutMessage,
    };
}
function timeoutForContext(ctx, config) {
    let timeoutMs = Number(config?.defaultTimeoutMs ?? 0);
    if (!Number.isFinite(timeoutMs))
        timeoutMs = 0;
    const tenant = String(ctx?.tenantId ?? "").trim();
    if (tenant && config?.tenantTimeoutsMs && tenant in config.tenantTimeoutsMs) {
        const override = Number(config.tenantTimeoutsMs[tenant]);
        if (Number.isFinite(override)) {
            timeoutMs = override;
        }
    }
    const method = String(ctx?.request?.method ?? "")
        .trim()
        .toUpperCase();
    const path = String(ctx?.request?.path ?? "").trim() || "/";
    const op = `${method}:${path}`;
    if (config?.operationTimeoutsMs && op in config.operationTimeoutsMs) {
        const override = Number(config.operationTimeoutsMs[op]);
        if (Number.isFinite(override)) {
            timeoutMs = override;
        }
    }
    const remainingMs = Number(ctx?.remainingMs ?? 0);
    if (Number.isFinite(remainingMs) &&
        remainingMs > 0 &&
        remainingMs < timeoutMs) {
        timeoutMs = remainingMs;
    }
    timeoutMs = Math.floor(timeoutMs);
    return timeoutMs;
}
export function timeoutMiddleware(config = {}) {
    const cfg = normalizeTimeoutConfig(config);
    return async (ctx, next) => {
        const timeoutMs = timeoutForContext(ctx, cfg);
        if (timeoutMs <= 0) {
            return next(ctx);
        }
        let timer = null;
        const timeoutPromise = new Promise((_resolve, reject) => {
            void _resolve;
            timer = setTimeout(() => reject(new AppError("app.timeout", cfg.timeoutMessage)), timeoutMs);
        });
        try {
            const run = Promise.resolve().then(() => next(ctx));
            return await Promise.race([run, timeoutPromise]);
        }
        finally {
            if (timer) {
                clearTimeout(timer);
            }
        }
    };
}
function extractTenantId(headers, query) {
    const headerTenant = firstHeaderValue(headers, "x-tenant-id");
    if (headerTenant)
        return headerTenant;
    const values = query["tenant"] ?? [];
    return values.length > 0 ? String(values[0]) : "";
}
function isCorsPreflight(method, headers) {
    return (normalizeMethod(method) === "OPTIONS" &&
        Boolean(firstHeaderValue(headers, "access-control-request-method")));
}
function normalizeCorsConfig(cors) {
    const allowCredentials = Boolean(cors?.allowCredentials);
    let allowedOrigins = null;
    if (cors && typeof cors === "object" && "allowedOrigins" in cors) {
        const raw = cors.allowedOrigins;
        if (Array.isArray(raw)) {
            const normalized = [];
            for (const origin of raw) {
                const trimmed = String(origin ?? "").trim();
                if (!trimmed)
                    continue;
                if (trimmed === "*") {
                    allowedOrigins = ["*"];
                    break;
                }
                normalized.push(trimmed);
            }
            if (!allowedOrigins) {
                allowedOrigins = normalized;
            }
        }
    }
    let allowHeaders = null;
    if (cors && typeof cors === "object" && "allowHeaders" in cors) {
        const raw = cors.allowHeaders;
        if (Array.isArray(raw)) {
            const normalized = [];
            for (const header of raw) {
                const trimmed = String(header ?? "").trim();
                if (!trimmed)
                    continue;
                normalized.push(trimmed);
            }
            allowHeaders = normalized;
        }
    }
    return { allowedOrigins, allowCredentials, allowHeaders };
}
function corsOriginAllowed(origin, cors) {
    const originValue = String(origin ?? "").trim();
    if (!originValue)
        return false;
    const allowed = cors.allowedOrigins;
    if (allowed === null) {
        return true;
    }
    if (!Array.isArray(allowed) || allowed.length === 0) {
        return false;
    }
    return allowed.some((entry) => entry === "*" || entry === originValue);
}
function corsAllowHeadersValue(cors) {
    const headers = Array.isArray(cors.allowHeaders) ? cors.allowHeaders : [];
    if (headers.length > 0) {
        return headers.join(", ");
    }
    if (cors.allowCredentials) {
        return "Content-Type, Authorization";
    }
    return "";
}
function finalizeP1Response(resp, requestId, origin, cors) {
    const headers = canonicalizeHeaders(resp.headers ?? {});
    if (requestId) {
        headers["x-request-id"] = [String(requestId)];
    }
    if (origin && corsOriginAllowed(origin, cors)) {
        headers["access-control-allow-origin"] = [String(origin)];
        headers["vary"] = vary(headers["vary"], "origin");
        if (cors.allowCredentials) {
            headers["access-control-allow-credentials"] = ["true"];
        }
        const allowHeaders = corsAllowHeadersValue(cors);
        if (allowHeaders) {
            headers["access-control-allow-headers"] = [allowHeaders];
        }
    }
    return { ...resp, headers };
}
function defaultPolicyMessage(code) {
    switch (String(code ?? "").trim()) {
        case "app.rate_limited":
            return "rate limited";
        case "app.overloaded":
            return "overloaded";
        default:
            return "internal error";
    }
}
function extractRemainingMs(ctx) {
    if (ctx && typeof ctx === "object") {
        if (typeof ctx
            .getRemainingTimeInMillis === "function") {
            const value = Number(ctx.getRemainingTimeInMillis());
            if (Number.isFinite(value) && value > 0) {
                return Math.floor(value);
            }
            return 0;
        }
        if ("remaining_ms" in ctx) {
            const value = Number(ctx["remaining_ms"]);
            if (Number.isFinite(value) && value > 0) {
                return Math.floor(value);
            }
            return 0;
        }
    }
    return 0;
}
function recordObservability(hooks, { method, path, requestId, tenantId, status, errorCode, }) {
    if (!hooks)
        return;
    let level = "info";
    if (status >= 500) {
        level = "error";
    }
    else if (status >= 400) {
        level = "warn";
    }
    if (typeof hooks.log === "function") {
        hooks.log({
            level,
            event: "request.completed",
            requestId,
            tenantId,
            method,
            path,
            status,
            errorCode,
        });
    }
    if (typeof hooks.metric === "function") {
        hooks.metric({
            name: "apptheory.request",
            value: 1,
            tags: {
                method,
                path,
                status: String(status),
                error_code: errorCode,
                tenant_id: tenantId,
            },
        });
    }
    if (typeof hooks.span === "function") {
        hooks.span({
            name: `http ${method} ${path}`,
            attributes: {
                "http.method": method,
                "http.route": path,
                "http.status_code": String(status),
                "request.id": requestId,
                "tenant.id": tenantId,
                "error.code": errorCode,
            },
        });
    }
}
function formatAllowHeader(methods) {
    const unique = new Set();
    for (const m of methods ?? []) {
        const normalized = normalizeMethod(m);
        if (normalized)
            unique.add(normalized);
    }
    return [...unique].sort().join(", ");
}
