import { json as jsonResponse } from "../response.js";
import { MICROVM_ERROR_CONTROLLER_COMMAND_FAILED, MICROVM_ERROR_CONTROLLER_INCOMPLETE, MICROVM_ERROR_INVALID_CONTROLLER_REQUEST, MICROVM_ERROR_PROVIDER_OPERATION_FAILED, MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE, MICROVM_ERROR_TENANT_BINDING_VIOLATION, MICROVM_ERROR_UNAUTHENTICATED_CONTROLLER, MicroVMCommand, MicroVMSafeError, } from "./model.js";
import { safeError } from "./errors.js";
import { controllerErrorResponse, normalizeMicroVMControllerRequest, } from "./controller.js";
import { normalizeMicroVMCommand } from "./controller-contract.js";
import { normalizeStringArray } from "./provider.js";
export function registerMicroVMControllerRoutes(app, controller) {
    if (!app) {
        throw new Error("apptheory: microvm controller route registration requires an app");
    }
    if (!controller) {
        throw safeError(MICROVM_ERROR_CONTROLLER_INCOMPLETE, "apptheory: microvm controller route registration requires a controller", "");
    }
    const routes = [
        { method: "POST", path: "/microvms", command: MicroVMCommand.Run },
        { method: "GET", path: "/microvms", command: MicroVMCommand.List },
        {
            method: "GET",
            path: "/microvms/{session_id}",
            command: MicroVMCommand.Get,
        },
        {
            method: "POST",
            path: "/microvms/{session_id}/suspend",
            command: MicroVMCommand.Suspend,
        },
        {
            method: "POST",
            path: "/microvms/{session_id}/resume",
            command: MicroVMCommand.Resume,
        },
        {
            method: "DELETE",
            path: "/microvms/{session_id}",
            command: MicroVMCommand.Terminate,
        },
        {
            method: "POST",
            path: "/microvms/{session_id}/auth-token",
            command: MicroVMCommand.AuthToken,
        },
        {
            method: "POST",
            path: "/microvms/{session_id}/shell-auth-token",
            command: MicroVMCommand.ShellAuthToken,
        },
        {
            method: "POST",
            path: "/microvms/{session_id}/shell-token",
            command: MicroVMCommand.ShellAuthToken,
        },
    ];
    for (const route of routes) {
        app.handleStrict(route.method, route.path, microVMControllerRouteHandler(controller, route.command), { authRequired: true });
    }
    return app;
}
export function registerControllerRoutes(app, controller) {
    return registerMicroVMControllerRoutes(app, controller);
}
export function microVMControllerRouteHandler(controller, command) {
    return async (ctx) => {
        const parsed = microVMControllerRequestFromHTTP(ctx, command);
        if (parsed instanceof MicroVMSafeError) {
            const request = {
                command,
                request_id: String(ctx?.requestId ?? "").trim(),
                tenant_id: String(ctx?.tenantId ?? "").trim(),
                namespace: "",
                auth_context: {
                    subject: String(ctx?.authIdentity ?? "").trim(),
                    tenant_id: String(ctx?.tenantId ?? "").trim(),
                },
            };
            return microVMControllerHTTPResponse(controllerErrorResponse(request, parsed));
        }
        const response = await controller.handle(parsed);
        return microVMControllerHTTPResponse(response);
    };
}
export function microVMControllerRequestFromHTTP(ctx, command) {
    if (!ctx) {
        return safeError(MICROVM_ERROR_INVALID_CONTROLLER_REQUEST, "apptheory: microvm controller route context is missing", "");
    }
    const payloadResult = microVMControllerRoutePayload(ctx);
    if (payloadResult instanceof MicroVMSafeError)
        return payloadResult;
    const payload = payloadResult;
    const pathSessionID = String(ctx.param("session_id") ?? "").trim();
    const bodySessionID = stringFromPayload(payload, "session_id");
    if (pathSessionID && bodySessionID && pathSessionID !== bodySessionID) {
        return safeError(MICROVM_ERROR_TENANT_BINDING_VIOLATION, "apptheory: microvm controller route session binding mismatch", ctx.requestId);
    }
    const ctxTenant = String(ctx.tenantId ?? "").trim();
    const bodyTenant = stringFromPayload(payload, "tenant_id");
    const queryTenant = firstQueryValue(ctx.request.query, "tenant_id");
    if (ctxTenant && bodyTenant && bodyTenant !== ctxTenant) {
        return safeError(MICROVM_ERROR_TENANT_BINDING_VIOLATION, "apptheory: microvm controller route tenant binding mismatch", ctx.requestId);
    }
    if (ctxTenant && queryTenant && queryTenant !== ctxTenant) {
        return safeError(MICROVM_ERROR_TENANT_BINDING_VIOLATION, "apptheory: microvm controller route tenant binding mismatch", ctx.requestId);
    }
    const namespace = stringFromPayload(payload, "namespace") ||
        firstHeaderValueFromMap(ctx.request.headers, "x-namespace-id") ||
        firstQueryValue(ctx.request.query, "namespace");
    const request = {
        command: normalizeMicroVMCommand(command),
        request_id: String(ctx.requestId ?? "").trim(),
        tenant_id: ctxTenant || bodyTenant || queryTenant,
        namespace,
        auth_context: {
            subject: String(ctx.authIdentity ?? "").trim(),
            tenant_id: ctxTenant,
            namespace,
        },
        session_id: pathSessionID || bodySessionID,
        image_ref: stringFromPayload(payload, "image_ref"),
        image_version: stringFromPayload(payload, "image_version"),
        network_connector_ref: stringFromPayload(payload, "network_connector_ref"),
        ingress_network_connector_refs: stringListFromPayload(payload, "ingress_network_connector_refs"),
        egress_network_connector_refs: stringListFromPayload(payload, "egress_network_connector_refs"),
        session_spec: sessionSpecFromPayload(payload),
        maximum_duration_seconds: intFromPayload(payload, "maximum_duration_seconds"),
        ttl_seconds: intFromPayload(payload, "ttl_seconds"),
        allowed_port_scope: portScopesFromPayload(payload),
        max_results: positiveIntFromPayload(payload, "max_results") ||
            positiveIntFromString(firstQueryValue(ctx.request.query, "max_results")),
    };
    const idlePolicy = idlePolicyFromPayload(payload);
    if (idlePolicy)
        request.idle_policy = idlePolicy;
    return normalizeMicroVMControllerRequest(request);
}
export function microVMControllerRoutePayload(ctx) {
    if ((ctx.request.body?.length ?? 0) === 0)
        return {};
    try {
        const parsed = JSON.parse(Buffer.from(ctx.request.body).toString("utf8"));
        if (parsed === null ||
            typeof parsed !== "object" ||
            Array.isArray(parsed)) {
            return safeError(MICROVM_ERROR_INVALID_CONTROLLER_REQUEST, "apptheory: microvm controller route request is malformed", ctx.requestId);
        }
        return parsed;
    }
    catch {
        return safeError(MICROVM_ERROR_INVALID_CONTROLLER_REQUEST, "apptheory: microvm controller route request is malformed", ctx.requestId);
    }
}
export function microVMControllerHTTPResponse(response) {
    return jsonResponse(microVMControllerHTTPStatus(response.error), serializableMicroVMControllerResponse(response));
}
export function microVMControllerHTTPStatus(err) {
    if (!err || !err.code)
        return 200;
    switch (err.code) {
        case MICROVM_ERROR_UNAUTHENTICATED_CONTROLLER:
            return 401;
        case MICROVM_ERROR_TENANT_BINDING_VIOLATION:
            return 403;
        case MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE:
            return 404;
        case MICROVM_ERROR_CONTROLLER_INCOMPLETE:
            return 500;
        case MICROVM_ERROR_CONTROLLER_COMMAND_FAILED:
        case MICROVM_ERROR_PROVIDER_OPERATION_FAILED:
            return 502;
        default:
            return 400;
    }
}
export function serializableMicroVMControllerResponse(response) {
    const out = { ...response };
    if (response.error) {
        out["error"] = {
            code: response.error.code,
            message: response.error.message,
            request_id: response.error.request_id ?? "",
        };
    }
    return out;
}
export function firstHeaderValueFromMap(headers, name) {
    const key = String(name ?? "")
        .trim()
        .toLowerCase();
    const values = headers[key] ?? headers[String(name ?? "").trim()] ?? [];
    return String(values[0] ?? "").trim();
}
export function firstQueryValue(query, name) {
    const values = query[String(name ?? "").trim()] ?? [];
    return String(values[0] ?? "").trim();
}
export function stringFromPayload(payload, key) {
    return String(payload[key] ?? "").trim();
}
export function stringListFromPayload(payload, key) {
    const value = payload[key];
    if (!Array.isArray(value))
        return [];
    return normalizeStringArray(value.map((item) => String(item ?? "")));
}
export function intFromPayload(payload, key) {
    return Math.trunc(Number(payload[key] ?? 0) || 0);
}
export function positiveIntFromPayload(payload, key) {
    const value = intFromPayload(payload, key);
    return value > 0 ? value : 0;
}
export function positiveIntFromString(value) {
    const parsed = Math.trunc(Number(String(value ?? "").trim()) || 0);
    return parsed > 0 ? parsed : 0;
}
export function sessionSpecFromPayload(payload) {
    const raw = payload["session_spec"];
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
        return {};
    const metadata = raw["metadata"];
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
        return {};
    }
    const out = {};
    for (const [key, value] of Object.entries(metadata)) {
        out[String(key).trim()] = String(value ?? "");
    }
    return Object.keys(out).length > 0 ? { metadata: out } : {};
}
export function idlePolicyFromPayload(payload) {
    const raw = payload["idle_policy"];
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
        return undefined;
    const record = raw;
    return {
        auto_resume_enabled: record["auto_resume_enabled"] === true,
        max_idle_duration_seconds: Math.trunc(Number(record["max_idle_duration_seconds"] ?? 0) || 0),
        suspended_duration_seconds: Math.trunc(Number(record["suspended_duration_seconds"] ?? 0) || 0),
    };
}
export function portScopesFromPayload(payload) {
    const raw = payload["allowed_port_scope"];
    if (!Array.isArray(raw))
        return [];
    return raw
        .filter((item) => Boolean(item) && typeof item === "object" && !Array.isArray(item))
        .map((scope) => ({
        all_ports: scope["all_ports"] === true,
        port: Math.trunc(Number(scope["port"] ?? 0) || 0),
        start_port: Math.trunc(Number(scope["start_port"] ?? 0) || 0),
        end_port: Math.trunc(Number(scope["end_port"] ?? 0) || 0),
    }));
}
//# sourceMappingURL=controller-routes.js.map