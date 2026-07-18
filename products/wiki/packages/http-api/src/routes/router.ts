import type { HttpPolicyOptions, HttpRequestContext, HttpRouteResult } from "../types.ts";
import { requireAuthenticatedHttpPolicy, resolveHttpPolicy } from "../auth.ts";
import { routeApiGraphSourceRoutes } from "./api-graph-sources.ts";
import { routeApiInboxRoutes } from "./api-inbox.ts";
import { routeApiMemoryRoutes } from "./api-memory.ts";
import { routeApiOperationsRoutes } from "./api-operations.ts";
import { routeApiPolicySearchRoutes } from "./api-policy-search.ts";
import { routeApiProposalMutationRoutes } from "./api-proposals.ts";
import { routeApiRecordRoutes } from "./api-records.ts";
import { routeApiWorkspaceRoutes } from "./api-workspaces.ts";
import { routeOAuthProtectedRoutes, routeOAuthPublicRoutes } from "../oauth.ts";
import { routeProtectedSystemRoutes, routePublicSystemRoutes } from "./system-http.ts";
import { routeWebCoreRoutes, routeWebRecordRoutes } from "./web.ts";

export interface HttpRouteHandlerContext {
  root: string;
  method: string;
  rawUrl: string;
  url: URL;
  body: unknown | undefined;
  policy: HttpPolicyOptions;
  context: HttpRequestContext;
}

type HttpRouteHandler = (input: HttpRouteHandlerContext) => Promise<HttpRouteResult | undefined>;

const HTTP_ROUTE_HANDLERS: HttpRouteHandler[] = [
  routeOAuthProtectedRoutes,
  routeProtectedSystemRoutes,
  routeWebCoreRoutes,
  routeWebRecordRoutes,
  routeApiPolicySearchRoutes,
  routeApiOperationsRoutes,
  routeApiMemoryRoutes,
  routeApiGraphSourceRoutes,
  routeApiInboxRoutes,
  routeApiProposalMutationRoutes,
  routeApiRecordRoutes,
  routeApiWorkspaceRoutes,
];

export async function routeHttpRequestInner(
  root: string,
  method: string,
  rawUrl: string,
  body?: unknown,
  policy: HttpPolicyOptions = {},
  context: HttpRequestContext = {},
): Promise<HttpRouteResult> {
  const url = new URL(rawUrl, "http://openwiki.local");
  const initialContext: HttpRouteHandlerContext = { root, method, rawUrl, url, body, policy, context };
  const publicResult = await routePublicSystemRoutes(initialContext);
  if (publicResult !== undefined) {
    return publicResult;
  }
  const oauthPublicResult = await routeOAuthPublicRoutes(initialContext);
  if (oauthPublicResult !== undefined) {
    return oauthPublicResult;
  }
  const routeContext: HttpRouteHandlerContext = { ...initialContext, policy: context.policyResolved === true ? policy : await resolveHttpPolicy(root, policy) };
  const authenticationFailure = await requireAuthenticatedHttpPolicy(root, routeContext.policy);
  if (authenticationFailure !== undefined) {
    return authenticationFailure;
  }
  for (const handler of HTTP_ROUTE_HANDLERS) {
    const result = await handler(routeContext);
    if (result !== undefined) {
      return result;
    }
  }
  return { status: 404, body: { error: { message: "Not found" } } };
}
