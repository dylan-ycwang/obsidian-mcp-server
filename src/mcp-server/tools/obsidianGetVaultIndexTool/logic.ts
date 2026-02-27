/**
 * @fileoverview Core logic for the 'obsidian_get_vault_index' tool.
 * This module defines the input schema, response types, and processing logic for
 * recursively walking the entire vault and returning a compact folder-level summary
 * with note counts and last modified dates, sorted by most recently modified first.
 *
 * Design: Two-phase parallel approach for scalability with large vaults:
 *   Phase 1 — Parallel recursive directory discovery (all branches explored concurrently)
 *   Phase 2 — Parallel metadata fetch with a shared concurrency limiter
 * @module src/mcp-server/tools/obsidianGetVaultIndexTool/logic
 */

import path from "node:path";
import { z } from "zod";
import {
  NoteJson,
  ObsidianRestApiService,
} from "../../../services/obsidianRestAPI/index.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";
import { logger, RequestContext } from "../../../utils/index.js";

// ====================================================================================
// Schema Definitions for Input Validation
// ====================================================================================

/**
 * Zod schema for validating the input parameters of the 'obsidian_get_vault_index' tool.
 * No parameters are required — the tool scans the entire vault.
 */
export const ObsidianGetVaultIndexInputSchema = z
  .object({})
  .describe(
    "No parameters required. Scans the entire vault and returns a compact folder-level summary.",
  );

/**
 * TypeScript type inferred from the input schema.
 */
export type ObsidianGetVaultIndexInput = z.infer<
  typeof ObsidianGetVaultIndexInputSchema
>;

// ====================================================================================
// Response & Internal Type Definitions
// ====================================================================================

/**
 * A single folder's summary in the vault index.
 */
interface FolderSummary {
  path: string;
  noteCount: number;
  lastModified: string;
}

/**
 * The structured response returned by the core logic function.
 */
export interface ObsidianGetVaultIndexResponse {
  totalFolders: number;
  totalNotes: number;
  folders: FolderSummary[];
}

/**
 * Internal representation of a discovered folder and its direct file paths.
 */
interface FolderContents {
  path: string;
  files: string[];
}

// ====================================================================================
// Parallel Concurrency Helper
// ====================================================================================

/** Maximum number of concurrent requests for file stat retrieval. */
const MAX_STAT_CONCURRENCY = 20;

/**
 * Maps an array of items through an async function with bounded concurrency.
 * Uses a worker-pool pattern safe under JavaScript's single-threaded model.
 *
 * @param items - The items to process.
 * @param fn - The async function to apply to each item.
 * @param concurrency - Maximum number of concurrent invocations.
 * @returns A promise resolving to an array of results in the same order as items.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () =>
      worker(),
    ),
  );
  return results;
}

// ====================================================================================
// Phase 1: Parallel Recursive Directory Discovery
// ====================================================================================

/**
 * Recursively discovers all folders and their direct file paths in the vault.
 * All subdirectories at each level are explored concurrently via Promise.all.
 *
 * @param dirPath - The vault-relative directory path ("" for root).
 * @param context - The request context for logging.
 * @param obsidianService - The Obsidian API service instance.
 * @returns A flat array of folder contents (one entry per folder in the vault).
 */
async function discoverFolders(
  dirPath: string,
  context: RequestContext,
  obsidianService: ObsidianRestApiService,
): Promise<FolderContents[]> {
  let entries: string[];
  try {
    entries = await obsidianService.listFiles(dirPath || "/", context);
  } catch (error) {
    if (error instanceof McpError && error.code === BaseErrorCode.NOT_FOUND) {
      logger.warning(
        `Directory not found during vault index walk: ${dirPath || "/"}. Skipping.`,
        context,
      );
      return [];
    }
    throw error;
  }

  const files = entries.filter((e) => !e.endsWith("/"));
  const subdirs = entries
    .filter((e) => e.endsWith("/"))
    .map((d) => d.slice(0, -1));

  const filePaths = files.map((f) =>
    dirPath ? path.posix.join(dirPath, f) : f,
  );

  const thisFolder: FolderContents = {
    path: dirPath || "/",
    files: filePaths,
  };

  const subdirPaths = subdirs.map((d) =>
    dirPath ? path.posix.join(dirPath, d) : d,
  );

  // Recurse all subdirectories in parallel
  const subdirResults = await Promise.all(
    subdirPaths.map((sd) => discoverFolders(sd, context, obsidianService)),
  );

  return [thisFolder, ...subdirResults.flat()];
}

// ====================================================================================
// Phase 2: Parallel Metadata Fetch
// ====================================================================================

/**
 * Fetches modification times for all given file paths by reading each file
 * in JSON format (`application/vnd.olrapi.note+json`), which returns a `NoteJson`
 * object containing `stat.mtime`. This is the proven approach used by the
 * `obsidian_read_note` tool — HEAD requests do not reliably return stat headers
 * from the Obsidian Local REST API.
 *
 * Uses a shared concurrency limiter to avoid overwhelming the API.
 *
 * @param filePaths - Vault-relative file paths to fetch metadata for.
 * @param context - The request context for logging.
 * @param obsidianService - The Obsidian API service instance.
 * @returns A map from file path to modification time (ms since epoch).
 */
async function fetchFileMtimes(
  filePaths: string[],
  context: RequestContext,
  obsidianService: ObsidianRestApiService,
): Promise<Map<string, number>> {
  const mtimeMap = new Map<string, number>();

  await mapWithConcurrency(
    filePaths,
    async (fp) => {
      try {
        const noteJson = (await obsidianService.getFileContent(
          fp,
          "json",
          context,
        )) as NoteJson;
        if (noteJson?.stat?.mtime > 0) {
          mtimeMap.set(fp, noteJson.stat.mtime);
        }
      } catch {
        // File couldn't be read as JSON (e.g., binary/non-markdown files) — skip
      }
    },
    MAX_STAT_CONCURRENCY,
  );

  return mtimeMap;
}

// ====================================================================================
// Core Logic Function
// ====================================================================================

/**
 * Processes the core logic for building a compact vault folder index.
 *
 * 1. Discovers all folders and their files via parallel recursive directory listing.
 * 2. Fetches modification times for all files via parallel JSON GET requests.
 * 3. Aggregates per-folder summaries (note count, most recent mtime).
 * 4. Sorts folders by most recently modified first.
 *
 * @param _params - The validated input parameters (empty object).
 * @param context - The request context for logging and correlation.
 * @param obsidianService - An instance of the Obsidian REST API service.
 * @returns A promise resolving to the structured vault index response.
 * @throws {McpError} Throws an McpError if the vault cannot be read.
 */
export const processObsidianGetVaultIndex = async (
  _params: ObsidianGetVaultIndexInput,
  context: RequestContext,
  obsidianService: ObsidianRestApiService,
): Promise<ObsidianGetVaultIndexResponse> => {
  logger.debug("Processing obsidian_get_vault_index request", context);

  try {
    // Phase 1: Discover all folders and their files in parallel
    const folders = await discoverFolders("", context, obsidianService);

    logger.debug(
      `Discovery complete: ${folders.length} folders found`,
      context,
    );

    // Collect all file paths across every folder for bulk metadata fetch
    const allFilePaths = folders.flatMap((f) => f.files);

    // Phase 2: Fetch metadata for all files with shared concurrency limit
    const mtimeMap = await fetchFileMtimes(
      allFilePaths,
      context,
      obsidianService,
    );

    logger.debug(
      `Metadata fetch complete: ${mtimeMap.size}/${allFilePaths.length} files resolved`,
      context,
    );

    // Phase 3: Aggregate per-folder summaries
    const folderData = folders.map((folder) => {
      let maxMtime = 0;
      for (const fp of folder.files) {
        const mtime = mtimeMap.get(fp);
        if (mtime !== undefined && mtime > maxMtime) {
          maxMtime = mtime;
        }
      }
      return {
        path: folder.path,
        noteCount: folder.files.length,
        lastModifiedMs: maxMtime,
      };
    });

    // Sort by most recently modified first
    folderData.sort((a, b) => b.lastModifiedMs - a.lastModifiedMs);

    const totalNotes = folderData.reduce((sum, f) => sum + f.noteCount, 0);

    // Format response — ISO 8601 timestamps for compactness
    const folderSummaries: FolderSummary[] = folderData.map((f) => ({
      path: f.path,
      noteCount: f.noteCount,
      lastModified:
        f.lastModifiedMs > 0
          ? new Date(f.lastModifiedMs).toISOString()
          : "N/A",
    }));

    const response: ObsidianGetVaultIndexResponse = {
      totalFolders: folderData.length,
      totalNotes,
      folders: folderSummaries,
    };

    logger.debug(
      `Vault index complete: ${folderData.length} folders, ${totalNotes} notes`,
      context,
    );

    return response;
  } catch (error) {
    if (error instanceof McpError) {
      throw error;
    }
    const errorMessage = "Unexpected error building vault index";
    logger.error(
      errorMessage,
      error instanceof Error ? error : undefined,
      context,
    );
    throw new McpError(
      BaseErrorCode.INTERNAL_ERROR,
      `${errorMessage}: ${error instanceof Error ? error.message : String(error)}`,
      context,
    );
  }
};
