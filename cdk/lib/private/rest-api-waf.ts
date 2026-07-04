import { ArnFormat, Stack } from "aws-cdk-lib";
import * as apigw from "aws-cdk-lib/aws-apigateway";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import { Construct } from "constructs";

import type { AppTheoryRegionalWafOptions } from "../regional-waf";

export interface AppTheoryRestApiWafResources {
  readonly webAcl?: wafv2.CfnWebACL;
  readonly wafAssociation: wafv2.CfnWebACLAssociation;
}

export function configureRestApiRegionalWaf(
  scope: Construct,
  api: apigw.RestApi,
  stage: apigw.IStage,
  input: boolean | AppTheoryRegionalWafOptions,
  defaultMetricName: string,
): AppTheoryRestApiWafResources {
  const options: AppTheoryRegionalWafOptions = input === true || input === false ? {} : input;
  const webAcl = options.webAclArn ? undefined : createWebAcl(scope, options, defaultMetricName);
  const association = new wafv2.CfnWebACLAssociation(scope, "WebAclAssociation", {
    resourceArn: restApiStageArn(api, stage),
    webAclArn: options.webAclArn ?? webAcl!.attrArn,
  });
  return { webAcl, wafAssociation: association };
}

function createWebAcl(
  scope: Construct,
  options: AppTheoryRegionalWafOptions,
  defaultMetricName: string,
): wafv2.CfnWebACL {
  const baseName = sanitizeMetricName(options.metricName ?? options.name ?? defaultMetricName);
  const rules: wafv2.CfnWebACL.RuleProperty[] = [
    {
      name: "AWSManagedRulesCommonRuleSet",
      priority: 0,
      overrideAction: { none: {} },
      statement: {
        managedRuleGroupStatement: {
          vendorName: "AWS",
          name: "AWSManagedRulesCommonRuleSet",
        },
      },
      visibilityConfig: wafVisibility(`${baseName}Common`),
    },
  ];

  if (options.rateLimit !== undefined) {
    const limit = Math.trunc(options.rateLimit);
    if (limit <= 0) {
      throw new Error("AppTheory regional WAF rateLimit must be greater than zero");
    }
    rules.push({
      name: "RateLimit",
      priority: 1,
      action: { block: {} },
      statement: {
        rateBasedStatement: {
          limit,
          aggregateKeyType: "IP",
        },
      },
      visibilityConfig: wafVisibility(`${baseName}RateLimit`),
    });
  }

  return new wafv2.CfnWebACL(scope, "WebAcl", {
    name: options.name,
    scope: "REGIONAL",
    defaultAction: { allow: {} },
    visibilityConfig: wafVisibility(baseName),
    rules,
  });
}

function restApiStageArn(api: apigw.RestApi, stage: apigw.IStage): string {
  return Stack.of(api).formatArn({
    service: "apigateway",
    account: "",
    resource: "/restapis",
    resourceName: `${api.restApiId}/stages/${stage.stageName}`,
    arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
  });
}

function wafVisibility(metricName: string): wafv2.CfnWebACL.VisibilityConfigProperty {
  return {
    cloudWatchMetricsEnabled: true,
    metricName: sanitizeMetricName(metricName),
    sampledRequestsEnabled: true,
  };
}

function sanitizeMetricName(input: string): string {
  const sanitized = String(input ?? "AppTheoryRestApi").replace(/[^A-Za-z0-9_-]/g, "");
  return sanitized || "AppTheoryRestApi";
}
