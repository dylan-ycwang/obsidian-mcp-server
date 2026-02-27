/**
 * @fileoverview Barrel file for the 'obsidian_get_vault_index' MCP tool.
 *
 * This file serves as the public entry point for the obsidian_get_vault_index tool module.
 * It re-exports the primary registration function (`registerObsidianGetVaultIndexTool`)
 * from the './registration.js' module.
 */
export { registerObsidianGetVaultIndexTool } from "./registration.js";
