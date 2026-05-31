import { cloudWebsiteClientAdminScript } from './client/admin-script.ts'
import { cloudWebsiteClientByokScript } from './client/byok-script.ts'
import { cloudWebsiteClientBindingsScript } from './client/bindings-script.ts'
import { cloudWebsiteClientCommonScript } from './client/common-script.ts'
import { cloudWebsiteClientDataScript } from './client/data-script.ts'
import { cloudWebsiteClientGatewayScript } from './client/gateway-script.ts'
import { cloudWebsiteClientOpsScript } from './client/ops-script.ts'
import { cloudWebsiteClientSessionPaginationScript } from './client/session-pagination-script.ts'
import { cloudWebsiteClientSurfacesScript } from './client/surfaces-script.ts'
import { cloudWebsiteClientWorkbenchScript } from './client/workbench-script.ts'

export function cloudWebsiteClientScript() {
  return [
    cloudWebsiteClientCommonScript(),
    cloudWebsiteClientAdminScript(),
    cloudWebsiteClientByokScript(),
    cloudWebsiteClientGatewayScript(),
    cloudWebsiteClientSurfacesScript(),
    cloudWebsiteClientOpsScript(),
    cloudWebsiteClientWorkbenchScript(),
    cloudWebsiteClientSessionPaginationScript(),
    cloudWebsiteClientDataScript(),
    cloudWebsiteClientBindingsScript(),
  ].join('\n')
}
