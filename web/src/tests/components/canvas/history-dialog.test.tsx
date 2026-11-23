import { expect, test } from "bun:test";

import type { CanvasNode } from "@/types";
import { installDom } from "@/tests/helpers/dom";
import instance from "@/utils/requests/request";

test("角色卡单图历史里的素材库可在原节点上替换主图", async () => {
  const dom = await installDom();
  const { ReactFlowProvider, useNodes } = await import("@xyflow/react");
  const { NodeHistoryDialog } = await import("@/components/canvas/history-dialog");
  const { VersionBadge } = await import("@/components/canvas/version-badge");
  const { useNodeHistoryStore } = await import("@/store/node-history");
  const { showVersionBadge } = await import("@/utils/canvas/versions");
  const originalAdapter = instance.defaults.adapter;
  const node: CanvasNode = {
    id: "role",
    type: "canvas",
    position: { x: 0, y: 0 },
    data: {
      kind: "character",
      label: "林川",
      status: "done",
      src: "/files/1.png",
      assetId: "1",
      mediaType: "image",
    },
  };
  const items = [
    {
      id: "library-2",
      asset: { id: "2", url: "/files/2.png", kind: "image", file_name: "新形象.png" },
    },
  ];
  instance.defaults.adapter = async (config) => ({
    status: 200,
    statusText: "OK",
    headers: {},
    config,
    data: {
      code: 0,
      msg: "ok",
      data: { items: config.url === "/asset-library/items" ? items : [], next_cursor: "" },
    },
  });

  function View() {
    const nodes = useNodes<CanvasNode>();
    const badge = showVersionBadge(nodes[0].data);
    return (
      <>
        {badge && <VersionBadge nodeId={node.id} badge={badge} />}
        <NodeHistoryDialog />
        <output>{JSON.stringify(nodes)}</output>
      </>
    );
  }

  const mounted = await dom.mount(
    <ReactFlowProvider defaultNodes={[node]}>
      <View />
    </ReactFlowProvider>,
  );
  try {
    const doc = dom.win.document;
    await dom.click(doc.querySelector('button[aria-label="历史记录，共 1 版"]'));
    expect(
      doc.querySelector('[data-slot="node-history-dialog"] [aria-pressed="true"]'),
    ).not.toBeNull();
    await dom.click(doc.querySelector('button[aria-label="更多"]'));
    const library = [...doc.querySelectorAll('[role="menuitem"]')].find(
      (item) => item.textContent?.trim() === "素材库",
    );
    expect(library).toBeDefined();
    await dom.click(library);
    const picker = doc.querySelector('[data-slot="asset-picker"]');
    expect(picker?.textContent).toContain("选择形象主图");
    const asset = picker?.querySelector('button[aria-label="新形象.png"]');
    expect(asset).not.toBeNull();
    await dom.click(asset);
    await dom.click(
      [...(picker?.querySelectorAll("button") ?? [])].find(
        (button) => button.textContent?.trim() === "确定",
      ),
    );

    const nodes = JSON.parse(
      mounted.container.querySelector("output")?.textContent ?? "[]",
    ) as CanvasNode[];
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ id: "role", data: { assetId: "2", activeOutputId: "2" } });
    expect(nodes[0].data.outputs?.map((output) => output.id)).toEqual(["1", "2"]);
    expect(
      doc
        .querySelector('[data-slot="node-history-dialog"] [aria-pressed="true"]')
        ?.getAttribute("aria-label"),
    ).toBe("第 2 版（当前主图）");
  } finally {
    await dom.act(() => useNodeHistoryStore.getState().close());
    await mounted.unmount();
    instance.defaults.adapter = originalAdapter;
    dom.restore();
  }
}, 20_000);
