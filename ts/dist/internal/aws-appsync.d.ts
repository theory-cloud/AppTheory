import type { AppSyncResolverEvent } from "../aws-types.js";
import { AppSyncContext } from "../context.js";
import type { Context } from "../context.js";
import type { Request, Response } from "../types.js";
export declare function isAppSyncResolverEvent(event: unknown): event is AppSyncResolverEvent;
export declare function requestFromAppSync(event: AppSyncResolverEvent): Request;
export declare function applyAppSyncContextValues(requestCtx: Context, event: AppSyncResolverEvent): void;
export declare function createAppSyncContext(event: AppSyncResolverEvent): AppSyncContext;
export declare function appSyncPayloadFromResponse(response: Response): unknown;
