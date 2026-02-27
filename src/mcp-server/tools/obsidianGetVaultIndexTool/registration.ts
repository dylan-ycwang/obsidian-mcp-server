/**
 * @fileoverview Registers the 'obsidian_get_vault_index' tool with the MCP server.
 * This file defines the tool's metadata and sets up the handler that links
 * the tool call to its core processing logic.
 * @module src/mcp-server/tools/obsidianGetVaultIndexTool/registration
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ObsidianRestApiService } from "../../../services/obsidianRestAPI/index.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";
import {
  ErrorHandler,
  logger,
  RequestContext,
  requestContextService,
} from "../../../utils/index.js";
// Import necessary types, schema, and logic function from the logic file
import type {
  ObsidianGetVaultIndexInput,
  ObsidianGetVaultIndexResponse,
} from "./logic.js";
import {
  ObsidianGetVaultIndexInputSchema,
  processObsidianGetVaultIndex,
} from "./logic.js";

/**
 * Registers the 'obsidian_get_vault_index' tool with the MCP server.
 *
 * This tool recursively walks the entire Obsidian vault and returns a compact
 * folder-level summary with note count and last modified date per folder,
 * sorted by most recently modified first. Uses parallel requests for scalability.
 *
 * @param {McpServer} server - The MCP server instance to register the tool with.
 * @param {ObsidianRestApiService} obsidianService - An instance of the Obsidian REST API service
 *   used to interact with the user's Obsidian vault.
 * @returns {Promise<void>} A promise that resolves when the tool registration is complete or rejects on error.
 * @throws {McpError} Throws an McpError if registration fails critically.
 */
export const registerObsidianGetVaultIndexTool = async (
  server: McpServer,
  obsidianService: ObsidianRestApiService,
): Promise<void> => {
  const toolName = "obsidian_get_vault_index";
  const toolDescription =
    "Recursively walks the entire Obsidian vault and returns a compact folder-level summary. Each folder entry includes the folder path, the number of notes it contains, and the last modified date (derived from the most recently modified file in that folder). Folders are sorted by most recently modified first. Returns folder-level summaries only — no individual file names. Takes no parameters.";

  // Create a context specifically for the registration process.
  const registrationContext: RequestContext =
    requestContextService.createRequestContext({
      operation: "RegisterObsidianGetVaultIndexTool",
      toolName: toolName,
      module: "ObsidianGetVaultIndexRegistration",
    });

  logger.info(`Attempting to register tool: ${toolName}`, registrationContext);

  // Wrap the registration logic in a tryCatch block for robust error handling during server setup.
  await ErrorHandler.tryCatch(
    async () => {
      // Use the high-level SDK method `server.tool` for registration.
      server.tool(
        toolName,
        toolDescription,
        ObsidianGetVaultIndexInputSchema.shape,
        /**
         * The handler function executed when the 'obsidian_get_vault_index' tool is called by the client.
         *
         * @param {ObsidianGetVaultIndexInput} params - The input parameters received from the client.
         * @returns {Promise<CallToolResult>} A promise resolving to the structured result for the MCP client.
         */
        async (params: ObsidianGetVaultIndexInput) => {
          // Create a specific context for this handler invocation.
          const handlerContext: RequestContext =
            requestContextService.createRequestContext({
              parentContext: registrationContext,
              operation: "HandleObsidianGetVaultIndexRequest",
              toolName: toolName,
            });
          logger.debug(`Handling '${toolName}' request`, handlerContext);

          // Wrap the core logic execution in a tryCatch block.
          return await ErrorHandler.tryCatch(
            async () => {
              const response: ObsidianGetVaultIndexResponse =
                await processObsidianGetVaultIndex(
                  params,
                  handlerContext,
                  obsidianService,
                );
              logger.debug(
                `'${toolName}' processed successfully`,
                handlerContext,
              );

              // Format the successful response into the required MCP CallToolResult structure.
              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(response, null, 2),
                  },
                ],
                isError: false,
              };
            },
            {
              operation: `processing ${toolName} handler`,
              context: handlerContext,
              input: params,
              errorMapper: (error: unknown) =>
                new McpError(
                  error instanceof McpError
                    ? error.code
                    : BaseErrorCode.INTERNAL_ERROR,
                  `Error processing ${toolName} tool: ${error instanceof Error ? error.message : "Unknown error"}`,
                  { ...handlerContext },
                ),
            },
          );
        },
      );

      logger.info(
        `Tool registered successfully: ${toolName}`,
        registrationContext,
      );
    },
    {
      operation: `registering tool ${toolName}`,
      context: registrationContext,
      errorCode: BaseErrorCode.INTERNAL_ERROR,
      errorMapper: (error: unknown) =>
        new McpError(
          error instanceof McpError ? error.code : BaseErrorCode.INTERNAL_ERROR,
          `Failed to register tool '${toolName}': ${error instanceof Error ? error.message : "Unknown error"}`,
          { ...registrationContext },
        ),
      critical: true,
    },
  );
};
