CREATE UNIQUE INDEX "compat_graph_nodes_scope_key"
  ON "compatibility_graph_nodes"(
    "id",
    "workspaceId",
    "graphId"
  );

ALTER TABLE "compatibility_graph_edges"
  DROP CONSTRAINT "compatibility_graph_edges_fromNodeId_workspaceId_fkey",
  DROP CONSTRAINT "compatibility_graph_edges_toNodeId_workspaceId_fkey";

ALTER TABLE "compatibility_graph_edges"
  ADD CONSTRAINT "compat_graph_edges_from_node_scope_fkey"
  FOREIGN KEY ("fromNodeId", "workspaceId", "graphId")
  REFERENCES "compatibility_graph_nodes"(
    "id",
    "workspaceId",
    "graphId"
  )
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "compatibility_graph_edges"
  ADD CONSTRAINT "compat_graph_edges_to_node_scope_fkey"
  FOREIGN KEY ("toNodeId", "workspaceId", "graphId")
  REFERENCES "compatibility_graph_nodes"(
    "id",
    "workspaceId",
    "graphId"
  )
  ON DELETE CASCADE ON UPDATE CASCADE;
