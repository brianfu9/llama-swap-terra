<!-- Test harness: QueuePanel under the app's Tooltip.Provider (App.svelte
     wraps the app in one; bits-ui's TooltipRootState requires the context).
     Not imported by the app. -->
<script lang="ts">
  import type { InflightRequestEntry } from "../lib/types";
  import * as Tooltip from "$lib/components/ui/tooltip/index.js";
  import QueuePanel from "./QueuePanel.svelte";

  let { inflightRequests }: { inflightRequests: InflightRequestEntry[] } = $props();
</script>

<Tooltip.Provider>
  <QueuePanel inflightRequests={inflightRequests} />
</Tooltip.Provider>
