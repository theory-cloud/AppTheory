import type { AppSyncResolverEvent } from "../aws-types.js";
import type { Request, Response } from "../types.js";
export declare function requestFromAppSync(event: AppSyncResolverEvent): Request;
export declare function appSyncPayloadFromResponse(response: Response): unknown;
