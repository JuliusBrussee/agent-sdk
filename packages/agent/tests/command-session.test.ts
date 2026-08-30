import {
  createCommandSessionRuntime,
  type CommandSessionRuntime,
  type CommandSessionWriteOptions,
} from "@caveman-ai/agent/command-session";

const runtime: CommandSessionRuntime = createCommandSessionRuntime();
const write: CommandSessionWriteOptions = {
  sessionId: "cmd_00000000000000000000000000000000",
  input: "",
  closeStdin: true,
};
void runtime.write(write);
void runtime.close();
