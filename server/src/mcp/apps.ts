import { readFileSync } from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/server';

/**
 * MCP Apps (io.modelcontextprotocol/ui, spec 2026-01-26): interactive views for hosts with a screen.
 * A tool points at a `ui://` resource through `_meta.ui.resourceUri`; the host reads that resource
 * and renders it in a sandboxed iframe. Voice-only hosts ignore all of this and keep the spoken text.
 */
export const UI_MIME_TYPE = 'text/html;profile=mcp-app';
export const CARE_DASHBOARD_URI = 'ui://carecircle/care-dashboard';

type Visibility = ('model' | 'app')[];

/** Tool `_meta` for MCP Apps. Visibility is explicit everywhere so the app can call only what it needs. */
export function uiMeta(visibility: Visibility, resourceUri?: string) {
  return { ui: { ...(resourceUri ? { resourceUri } : {}), visibility } };
}

// Lives outside src/ so tsc doesn't need to copy it: ../../ui resolves from both src/mcp and dist/mcp.
const dashboardHtml = readFileSync(new URL('../../ui/care-dashboard.html', import.meta.url), 'utf8');

export function registerApps(server: McpServer): void {
  server.registerResource(
    'care-dashboard',
    CARE_DASHBOARD_URI,
    {
      title: "Today's care dashboard",
      description: "Interactive view for get_care_status: today's doses with Mark taken buttons, refills, visits and the latest note.",
      mimeType: UI_MIME_TYPE
    },
    async uri => ({
      contents: [
        {
          uri: uri.href,
          mimeType: UI_MIME_TYPE,
          text: dashboardHtml,
          // Fully self-contained: no network, no external scripts, styles or fonts.
          _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: false } }
        }
      ]
    })
  );
}
