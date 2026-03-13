# AppSync Lambda Resolvers

Use this guide when wiring an AWS AppSync Lambda data source to an AppTheory app.

AppTheory supports the standard direct Lambda resolver event shape in Go, TypeScript, and Python. You do not need
request mapping template rewrites to use the runtime adapters documented here.

## Choose the entrypoint

Use the explicit AppSync entrypoint when the Lambda is dedicated to AppSync:

- Go: `app.ServeAppSync(ctx, event)`
- TypeScript: `app.serveAppSync(event, ctx)`
- Python: `app.serve_appsync(event, ctx)`

Use the universal dispatcher when the same Lambda also accepts other AWS trigger types:

- Go: `app.HandleLambda(ctx, event)`
- TypeScript: `app.handleLambda(event, ctx)`
- Python: `app.handle_lambda(event, ctx)`

The dispatcher detects standard AppSync resolver events from:

- `info.fieldName`
- `info.parentTypeName`
- `arguments`

## Routing model

AppTheory adapts the AppSync resolver event into the normal route matcher:

- `Mutation -> POST /fieldName`
- `Query -> GET /fieldName`
- `Subscription -> GET /fieldName`
- top-level `arguments` become the JSON request body
- `request.headers` are forwarded
- `content-type: application/json` is synthesized when absent

Resolver metadata stays available on the request context:

- Go: `ctx.AsAppSync()`
- TypeScript: `ctx.asAppSync()`
- Python: `ctx.as_appsync()`

The typed AppSync context exposes field name, parent type name, arguments, identity, source, variables, stash, prev,
request headers, and the raw event.

Selection-set-aware handlers can read the preserved raw event data directly:

- Go: `ctx.AsAppSync().RawEvent.Info.SelectionSetList`, `SelectionSetGraphQL`
- TypeScript: `ctx.asAppSync()?.rawEvent.info.selectionSetList`, `selectionSetGraphQL`
- Python: `ctx.as_appsync().raw_event["info"]["selectionSetList"]`, `selectionSetGraphQL`

Portable metadata keys are also populated on the generic request context:

- `apptheory.trigger_type`
- `apptheory.appsync.field_name`
- `apptheory.appsync.parent_type_name`
- `apptheory.appsync.arguments`
- `apptheory.appsync.identity`
- `apptheory.appsync.source`
- `apptheory.appsync.variables`
- `apptheory.appsync.prev`
- `apptheory.appsync.stash`
- `apptheory.appsync.request_headers`
- `apptheory.appsync.raw_event`

## Minimal shape

Given a GraphQL field like `Query.getThing`, register the matching AppTheory route as `GET /getThing`.

Given a GraphQL field like `Mutation.updateThing`, register the matching AppTheory route as `POST /updateThing`.

## Go example

```go
package main

import (
	"context"
	"encoding/json"

	apptheory "github.com/theory-cloud/apptheory/runtime"
)

var app = apptheory.New()

func init() {
	app.Get("/getThing", func(ctx *apptheory.Context) (*apptheory.Response, error) {
		args, err := ctx.JSONValue()
		if err != nil {
			return nil, err
		}
		appsync := ctx.AsAppSync()
		return apptheory.JSON(200, map[string]any{
			"id":         args["id"],
			"field_name": appsync.FieldName,
		}), nil
	})
}

func handler(ctx context.Context, event json.RawMessage) (any, error) {
	return app.HandleLambda(ctx, event)
}
```

If the Lambda is AppSync-only, the handler can instead accept `apptheory.AppSyncResolverEvent` and call
`app.ServeAppSync(ctx, event)`.

## TypeScript example

```ts
import {
  type AppSyncResolverEvent,
  createApp,
  json,
} from "@theory-cloud/apptheory";

const app = createApp();

app.get("/getThing", async (ctx) => {
  const args = await ctx.jsonValue<Record<string, unknown>>();
  const appsync = ctx.asAppSync();
  return json(200, {
    id: args.id,
    field_name: appsync?.fieldName ?? "",
  });
});

export const handler = (event: AppSyncResolverEvent, ctx: unknown) =>
  app.serveAppSync(event, ctx);
```

## Python example

```py
from typing import Any

from apptheory import AppSyncResolverEvent, create_app, json

app = create_app()


@app.get("/getThing")
def get_thing(ctx):
    args = ctx.json_value()
    appsync = ctx.as_appsync()
    return json(
        200,
        {
            "id": args.get("id"),
            "field_name": appsync.field_name if appsync else "",
        },
    )


def handler(event: AppSyncResolverEvent, ctx: Any) -> Any:
    return app.serve_appsync(event, ctx=ctx)
```

## Response and error behavior

Successful AppSync handlers return resolver payloads, not API Gateway-style envelopes:

- JSON bodies project to native resolver values
- empty bodies project to `null`
- any other non-empty body projects to a UTF-8 string

Handler failures return Lift-compatible AppSync error objects:

- `pay_theory_error`
- `error_message`
- `error_type`
- `error_data`
- `error_info`

Portable AppTheory/AppError values also carry deterministic metadata:

- `error_data.status_code`
- optional `error_data.request_id`, `trace_id`, `timestamp`
- `error_info.code`, `trigger_type`, `method`, `path`, and optional `details`

Binary and streaming response bodies are intentionally out of scope for AppSync and fail closed with deterministic
system-error envelopes.

## Local tests

Use the deterministic AppSync builders in each runtime:

- Go: `testkit.AppSyncEvent(...)`, `env.InvokeAppSync(...)`
- TypeScript: `buildAppSyncEvent(...)`, `env.invokeAppSync(...)`
- Python: `build_appsync_event(...)`, `env.invoke_appsync(...)`
