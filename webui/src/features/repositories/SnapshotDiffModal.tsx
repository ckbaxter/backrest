import React, { useEffect, useMemo, useRef, useState } from "react";
import { create } from "@bufbuild/protobuf";
import {
  Box,
  Stack,
  Flex,
  Text,
  Button,
  Spinner,
  Table,
  Badge,
  Input,
  Heading,
} from "@chakra-ui/react";

import {
  GetOperationsRequestSchema,
  ListSnapshotsRequestSchema,
  LogDataRequestSchema,
  OpSelectorSchema,
  RunCommandRequestSchema,
} from "../../../gen/ts/v1/service_pb";
import { Operation, OperationStatus } from "../../../gen/ts/v1/operations_pb";
import { ResticSnapshot } from "../../../gen/ts/v1/restic_pb";
import { backrestService } from "../../api/client";
import { getOperations } from "../../api/oplog";
import { useShowModal } from "../../components/common/ModalManager";
import { FormModal } from "../../components/common/FormModal";
import { EnumSelector } from "../../components/common/EnumSelector";
import { alerts } from "../../components/common/Alerts";
import { formatBytes, formatTime, normalizeSnapshotId } from "../../lib/formatting";

import * as m from "../../paraglide/messages";

// This view is built on top of Backrest's existing "RunCommand" RPC rather
// than a dedicated Diff RPC: it shells out to `restic diff --json <a> <b>`
// and parses the JSON-lines output restic itself produces. This keeps the
// feature entirely in the webui layer without requiring any changes to the
// protobuf schema or Go backend.
//
// See: https://restic.readthedocs.io/en/stable/075_scripting.html (diff command JSON schema)

interface ResticDiffChange {
  message_type: "change";
  path: string;
  modifier: string; // one or more concatenated modifier characters, e.g. "+", "-", "M", "U", "T", "?", "TM", "M?"
}

interface ResticDiffStat {
  files: number;
  dirs: number;
  others: number;
  data_blobs: number;
  tree_blobs: number;
  bytes: number;
}

interface ResticDiffStatistics {
  message_type: "statistics";
  source_snapshot: string;
  target_snapshot: string;
  changed_files: number;
  added: ResticDiffStat;
  removed: ResticDiffStat;
}

const parseDiffOutput = (
  text: string,
): {
  changes: ResticDiffChange[];
  stats: ResticDiffStatistics | null;
  rawUnparsed: string[];
} => {
  const changes: ResticDiffChange[] = [];
  let stats: ResticDiffStatistics | null = null;
  const rawUnparsed: string[] = [];

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && obj.message_type === "change") {
        changes.push(obj as ResticDiffChange);
      } else if (obj && obj.message_type === "statistics") {
        stats = obj as ResticDiffStatistics;
      } else {
        rawUnparsed.push(line);
      }
    } catch {
      rawUnparsed.push(line);
    }
  }

  return { changes, stats, rawUnparsed };
};

const MODIFIER_INFO: Record<string, { label: string; colorPalette: string }> = {
  "+": { label: "added", colorPalette: "green" },
  "-": { label: "removed", colorPalette: "red" },
  M: { label: "modified", colorPalette: "orange" },
  U: { label: "metadata", colorPalette: "gray" },
  T: { label: "type changed", colorPalette: "blue" },
  "?": { label: "bitrot?", colorPalette: "purple" },
};

const ModifierBadges = ({ modifier }: { modifier: string }) => {
  const chars = Array.from(modifier);
  return (
    <Flex gap={1} wrap="wrap">
      {chars.map((ch, idx) => {
        const info = MODIFIER_INFO[ch] || { label: ch, colorPalette: "gray" };
        return (
          <Badge key={idx} size="sm" colorPalette={info.colorPalette}>
            {ch} {info.label}
          </Badge>
        );
      })}
    </Flex>
  );
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Sentinel plan ID Backrest assigns to operations/snapshots that were not
// created by a configured backup plan (e.g. imported/indexed snapshots from
// an external backup script). It is not a real plan in the config, so it
// must never be sent to RPCs that look up a plan by ID (see
// internal/orchestrator/tasks/task.go: PlanForUnassociatedOperations).
const PLAN_UNASSOCIATED = "_unassociated_";

const MAX_DISPLAYED_CHANGES = 2000;

export const SnapshotDiffModal = ({
  repoId,
  planId,
  snapshot,
}: React.PropsWithoutRef<{
  repoId: string;
  planId?: string;
  snapshot: ResticSnapshot;
}>) => {
  const showModal = useShowModal();
  const cancelledRef = useRef(false);

  const [loadingSnapshots, setLoadingSnapshots] = useState(true);
  const [otherSnapshots, setOtherSnapshots] = useState<ResticSnapshot[]>([]);
  const [compareToId, setCompareToId] = useState<string>("");

  const [phase, setPhase] = useState<"idle" | "running" | "success" | "error">(
    "idle",
  );
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [changes, setChanges] = useState<ResticDiffChange[]>([]);
  const [stats, setStats] = useState<ResticDiffStatistics | null>(null);
  const [rawUnparsed, setRawUnparsed] = useState<string[]>([]);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingSnapshots(true);
      try {
        const resp = await backrestService.listSnapshots(
          create(ListSnapshotsRequestSchema, {
            repoId,
            planId: planId && planId !== PLAN_UNASSOCIATED ? planId : "",
          }),
        );
        if (cancelled) return;

        const others = (resp.snapshots || [])
          .filter((s) => s.id !== snapshot.id)
          .sort((a, b) => Number(a.unixTimeMs - b.unixTimeMs));
        setOtherSnapshots(others);

        // Default to the snapshot immediately preceding this one in time, so
        // "compare" defaults to answering "what changed since the last backup".
        let defaultId = "";
        let bestTime = -1n;
        for (const s of others) {
          if (s.unixTimeMs < snapshot.unixTimeMs && s.unixTimeMs > bestTime) {
            bestTime = s.unixTimeMs;
            defaultId = s.id;
          }
        }
        if (!defaultId && others.length > 0) {
          defaultId = others[others.length - 1].id;
        }
        setCompareToId(defaultId);
      } catch (e: any) {
        if (!cancelled) {
          alerts.error(
            "Failed to load snapshots for this repo: " + (e.message || e),
          );
        }
      } finally {
        if (!cancelled) setLoadingSnapshots(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repoId, planId, snapshot.id]);

  const runDiff = async () => {
    if (!compareToId) return;

    setPhase("running");
    setErrorMsg(null);
    setChanges([]);
    setStats(null);
    setRawUnparsed([]);

    try {
      const resp = await backrestService.runCommand(
        create(RunCommandRequestSchema, {
          repoId,
          command: `diff --json ${compareToId} ${snapshot.id}`,
        }),
      );
      const opId = resp.operationId;

      let finalOp: Operation | null = null;
      while (!cancelledRef.current) {
        const ops = await getOperations(
          create(GetOperationsRequestSchema, {
            selector: create(OpSelectorSchema, { ids: [opId] }),
          }),
        );
        if (ops.length > 0) {
          const op = ops[0];
          if (
            op.status !== OperationStatus.STATUS_PENDING &&
            op.status !== OperationStatus.STATUS_INPROGRESS
          ) {
            finalOp = op;
            break;
          }
        }
        await sleep(750);
      }

      if (cancelledRef.current) return;
      if (!finalOp) {
        throw new Error("diff operation did not complete");
      }

      let logref: string | undefined;
      if (finalOp.op.case === "operationRunCommand") {
        logref = finalOp.op.value.outputLogref;
      }

      let fullText = "";
      if (logref) {
        for await (const chunk of backrestService.getLogs(
          create(LogDataRequestSchema, { ref: logref }),
        )) {
          fullText += new TextDecoder("utf-8").decode(chunk.value);
        }
      }

      const parsed = parseDiffOutput(fullText);
      if (cancelledRef.current) return;

      setChanges(parsed.changes);
      setStats(parsed.stats);
      setRawUnparsed(parsed.rawUnparsed);

      if (
        finalOp.status === OperationStatus.STATUS_SUCCESS ||
        finalOp.status === OperationStatus.STATUS_WARNING
      ) {
        setPhase("success");
      } else {
        setPhase("error");
        setErrorMsg(finalOp.displayMessage || "restic diff failed");
      }
    } catch (e: any) {
      if (!cancelledRef.current) {
        setPhase("error");
        setErrorMsg(e.message || String(e));
      }
    }
  };

  const filteredChanges = useMemo(() => {
    if (!filter) return changes;
    const f = filter.toLowerCase();
    return changes.filter((c) => c.path.toLowerCase().includes(f));
  }, [changes, filter]);

  const displayedChanges = filteredChanges.slice(0, MAX_DISPLAYED_CHANGES);

  const snapshotOptions = otherSnapshots.map((s) => ({
    value: s.id,
    label: `${formatTime(Number(s.unixTimeMs))} (${normalizeSnapshotId(s.id)})`,
  }));

  return (
    <FormModal
      size="large"
      title={`Compare snapshot ${normalizeSnapshotId(snapshot.id)}`}
      isOpen={true}
      onClose={() => showModal(null)}
      footer={
        <>
          <Button variant="ghost" onClick={() => showModal(null)}>
            {m.button_close()}
          </Button>
          <Button
            colorPalette="blue"
            loading={phase === "running"}
            disabled={
              loadingSnapshots || !compareToId || phase === "running"
            }
            onClick={runDiff}
          >
            {phase === "success" || phase === "error"
              ? "Compare again"
              : "Compare"}
          </Button>
        </>
      }
    >
      <Stack gap={4}>
        <Box>
          <Text mb={2}>
            Show what changed in this snapshot compared to:
          </Text>
          {loadingSnapshots ? (
            <Spinner size="sm" />
          ) : snapshotOptions.length === 0 ? (
            <Text color="fg.muted" fontStyle="italic">
              No other snapshots are available in this repository to compare
              against.
            </Text>
          ) : (
            <EnumSelector<string>
              value={compareToId}
              onChange={(v) => setCompareToId(v as string)}
              options={snapshotOptions}
              placeholder="Select a snapshot"
              ariaLabel="Snapshot to compare against"
            />
          )}
        </Box>

        {phase === "running" && (
          <Flex align="center" gap={2}>
            <Spinner size="sm" />
            <Text>Running restic diff...</Text>
          </Flex>
        )}

        {phase === "error" && (
          <Box p={3} bg="bg.muted" borderRadius="md" borderLeft="4px solid" borderColor="red.500">
            <Text color="red.500" fontWeight="bold">
              Diff failed
            </Text>
            <Text>{errorMsg}</Text>
          </Box>
        )}

        {phase === "success" && (
          <Stack gap={3}>
            {stats && (
              <Flex gap={4} wrap="wrap">
                <Badge size="lg" colorPalette="orange">
                  {stats.changed_files} changed
                </Badge>
                <Badge size="lg" colorPalette="green">
                  +{stats.added.files} files ({formatBytes(stats.added.bytes)})
                </Badge>
                <Badge size="lg" colorPalette="red">
                  -{stats.removed.files} files (
                  {formatBytes(stats.removed.bytes)})
                </Badge>
              </Flex>
            )}

            {changes.length > 0 && (
              <Input
                size="sm"
                placeholder="Filter by path..."
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            )}

            {changes.length === 0 ? (
              <Text color="fg.muted" fontStyle="italic">
                No differences found between these two snapshots.
              </Text>
            ) : (
              <Box maxH="400px" overflow="auto">
                <Table.Root size="sm" variant="outline">
                  <Table.Header>
                    <Table.Row>
                      <Table.ColumnHeader>Change</Table.ColumnHeader>
                      <Table.ColumnHeader>Path</Table.ColumnHeader>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {displayedChanges.map((c, idx) => (
                      <Table.Row key={idx}>
                        <Table.Cell verticalAlign="top">
                          <ModifierBadges modifier={c.modifier} />
                        </Table.Cell>
                        <Table.Cell
                          verticalAlign="top"
                          wordBreak="break-all"
                          fontFamily="mono"
                          fontSize="sm"
                        >
                          {c.path}
                        </Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table.Root>
                {filteredChanges.length > MAX_DISPLAYED_CHANGES && (
                  <Text color="fg.muted" fontSize="sm" mt={2}>
                    Showing first {MAX_DISPLAYED_CHANGES} of{" "}
                    {filteredChanges.length} changes. Use the filter above to
                    narrow the results.
                  </Text>
                )}
              </Box>
            )}
          </Stack>
        )}

        {rawUnparsed.length > 0 && (
          <Box>
            <Heading size="xs" mb={1}>
              Unparsed restic output
            </Heading>
            <Box
              as="pre"
              overflow="auto"
              maxH="150px"
              p={2}
              bg="bg.muted"
              borderRadius="md"
              fontSize="xs"
            >
              {rawUnparsed.join("\n")}
            </Box>
          </Box>
        )}
      </Stack>
    </FormModal>
  );
};
