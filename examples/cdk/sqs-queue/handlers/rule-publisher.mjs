import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";

const client = new EventBridgeClient({});
const busName = process.env.BUS_NAME;
const busArn = process.env.BUS_ARN;

/**
 * Publishes one event for each rule-target shape through the real EventBridge
 * SDK. The local runner serves the PutEvents protocol; the handler is never
 * given a runner shortcut.
 */
export const handler = async () => {
  const entries = [
    {
      Source: "apptheory.rule",
      DetailType: "path",
      Detail: JSON.stringify({ item: "path-value" }),
      EventBusName: busName,
    },
    {
      Source: "apptheory.rule",
      DetailType: "transform",
      Detail: JSON.stringify({ item: "transform-value" }),
      // The ARN form AWS documents, not the bus name.
      EventBusName: busArn,
    },
    {
      Source: "apptheory.rule",
      DetailType: "static",
      Detail: JSON.stringify({}),
      EventBusName: "default",
    },
    {
      Source: "apptheory.rule",
      DetailType: "fail",
      Detail: JSON.stringify({ item: "fail-value" }),
      EventBusName: busName,
    },
  ];
  const response = await client.send(new PutEventsCommand({ Entries: entries }));
  return {
    failedEntryCount: response.FailedEntryCount ?? 0,
    eventIds: (response.Entries ?? []).map((entry) => entry.EventId),
  };
};
