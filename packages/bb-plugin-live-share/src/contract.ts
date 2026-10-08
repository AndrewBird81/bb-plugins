// Contract between the plugin server and its host worker, which runs the
// public gateway and the OpenTunnel connection.
import {
  defineRpcContract,
  type ExperimentalHostSignals,
} from "@get-bb/plugin-sdk";
import { z } from "zod";

export const exposureSchema = z.enum(["opentunnel", "local"]);
export type Exposure = z.infer<typeof exposureSchema>;

export const gatewayStatusSchema = z
  .object({
    running: z.boolean(),
    exposure: exposureSchema.nullable(),
    localUrl: z.string().nullable(),
    publicUrl: z.string().nullable(),
    tunnel: z.enum(["off", "connecting", "connected", "reconnecting", "error"]),
    error: z.string().nullable(),
  })
  .strict();
export type GatewayStatus = z.infer<typeof gatewayStatusSchema>;

export const hostContract = defineRpcContract({
  start: {
    input: z
      .object({
        upstreamBaseUrl: z.string().url(),
        pluginId: z.string().min(1),
        pluginToken: z.string().min(1),
        exposure: exposureSchema,
        port: z.number().int().min(0).max(65_535),
      })
      .strict(),
    output: gatewayStatusSchema,
  },
  stop: {
    input: z.null(),
    output: gatewayStatusSchema,
  },
  status: {
    input: z.null(),
    output: gatewayStatusSchema,
  },
});

export const hostSignals = {
  status: { payload: gatewayStatusSchema },
} satisfies ExperimentalHostSignals;
