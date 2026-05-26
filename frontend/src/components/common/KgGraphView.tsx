import { useEffect, useRef, useCallback } from "react";
import cytoscape from "cytoscape";
import type { KgEntity, KgRelation } from "../../api/types";

interface KgGraphViewProps {
  entities: KgEntity[];
  relations: KgRelation[];
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  height?: number | string;
}

const TYPE_COLORS: Record<string, string> = {
  concept: "#2383e2",
  person: "#16a34a",
  organization: "#dc2626",
  location: "#ca8a04",
  event: "#9333ea",
  product: "#db2777",
  technology: "#0891b2",
};

function getNodeColor(type: string) {
  return TYPE_COLORS[type] || "#666666";
}

export default function KgGraphView({ entities, relations, selectedId, onSelect, height = 500 }: KgGraphViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<cytoscape.Core | null>(null);

  const initCy = useCallback(() => {
    if (!containerRef.current || entities.length === 0) return;

    const cy = cytoscape({
      container: containerRef.current,
      elements: [
        ...entities.map((e) => ({
          data: {
            id: e.id,
            label: e.name,
            type: e.type,
            mentionCount: e.mentionCount,
          },
          selected: e.id === selectedId,
        })),
        ...relations.map((r) => ({
          data: {
            id: r.id,
            source: r.source,
            target: r.target,
            label: r.type,
            confidence: r.confidence,
          },
        })),
      ],
      style: [
        {
          selector: "node",
          style: {
            "background-color": (ele: cytoscape.NodeSingular) => getNodeColor(ele.data("type")),
            label: "data(label)",
            color: "#37352f",
            "font-size": "12px",
            "font-weight": 500,
            "text-valign": "bottom",
            "text-halign": "center",
            "text-margin-y": 6,
            width: (ele: cytoscape.NodeSingular) => Math.max(24, Math.min(48, 24 + ele.data("mentionCount") * 4)),
            height: (ele: cytoscape.NodeSingular) => Math.max(24, Math.min(48, 24 + ele.data("mentionCount") * 4)),
            "border-width": 2,
            "border-color": "#ffffff",
            "border-opacity": 1,
          },
        },
        {
          selector: "node:selected",
          style: {
            "border-width": 3,
            "border-color": "#000000",
          },
        },
        {
          selector: "edge",
          style: {
            width: (ele: cytoscape.EdgeSingular) => Math.max(1, ele.data("confidence") * 3),
            "line-color": "#d4d4d8",
            "target-arrow-color": "#d4d4d8",
            "target-arrow-shape": "triangle",
            "curve-style": "bezier",
            label: "data(label)",
            "font-size": "10px",
            color: "#a1a1aa",
            "text-background-color": "#ffffff",
            "text-background-opacity": 0.9,
            "text-background-padding": "2px 4px",
            "text-background-shape": "roundrectangle",
          },
        },
        {
          selector: "edge:selected",
          style: {
            "line-color": "#000000",
            "target-arrow-color": "#000000",
            width: 3,
          },
        },
      ],
      layout: {
        name: "cose",
        padding: 24,
        nodeRepulsion: 8000,
        edgeElasticity: 100,
        nestingFactor: 5,
        gravity: 20,
        numIter: 1000,
        initialTemp: 200,
        coolingFactor: 0.95,
        minTemp: 1.0,
        animate: false,
        fit: true,
      } as any,
      minZoom: 0.3,
      maxZoom: 3,
      wheelSensitivity: 0.3,
    });

    cy.on("tap", "node", (evt) => {
      const id = evt.target.id();
      onSelect?.(id);
    });

    cyRef.current = cy;
  }, [entities, relations, selectedId, onSelect]);

  useEffect(() => {
    initCy();
    return () => {
      cyRef.current?.destroy();
      cyRef.current = null;
    };
  }, [initCy]);

  // Update selection without full re-init
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.nodes().unselect();
    if (selectedId) {
      const node = cy.getElementById(selectedId);
      if (node.length > 0) {
        node.select();
        cy.animate({ fit: { eles: node, padding: 60 } }, { duration: 300 });
      }
    }
  }, [selectedId]);

  if (entities.length === 0) {
    return (
      <div
        style={{
          height,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--c-text-3)",
          fontSize: 14,
          border: "1px dashed var(--c-border)",
          borderRadius: 12,
        }}
      >
        暂无实体数据
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      style={{
        height,
        width: "100%",
        borderRadius: 12,
        border: "1px solid var(--c-border)",
        background: "var(--c-page)",
      }}
    />
  );
}
