// @vitest-environment happy-dom
//
// Smoke test for the request-queue column picker. The "can't click the column
// selector" regression — GroupHeading rendered outside a DropdownMenu.Group,
// so bits-ui threw "Menu.Group | Menu.RadioGroup not found" while rendering
// the content, and the poisoned shared portal then positioned the activity
// table's picker off-screen — is verified end-to-end by the playwright run:
// under happy-dom the bits-ui floating layer never settles, the content never
// reaches the DOM, and the Group-context throw never fires, so this test only
// guards that the trigger renders and that a real mouse press toggles it open.
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it } from "vitest";
import QueuePanel from "./QueuePanel.svelte";
import { inflightRequestEntries, queueSnapshots } from "../stores/api";

describe("request queue column picker", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    window.localStorage.clear();
    queueSnapshots.set([]);
    inflightRequestEntries.set([]);
  });

  it("toggles open on a real mouse press", () => {
    const panel = mount(QueuePanel, {
      target: document.body,
      props: { inflightRequests: [] },
    });
    const trigger = document.body.querySelector(
      '[data-slot="dropdown-menu-trigger"]'
    ) as HTMLElement;
    expect(trigger, "the column picker trigger should render").not.toBeNull();

    // A real mouse press is pointerdown(button 0) + pointerup + a click with
    // detail 1: bits-ui toggles on the pointerdown and ignores the click
    // (detail !== 0). A detail-0 click would toggle a second time.
    trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    trigger.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0 }));
    trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    flushSync();

    expect(trigger.getAttribute("data-state")).toBe("open");
    unmount(panel);
  });
});
