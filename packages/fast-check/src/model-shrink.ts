import { minimizeFailureSet, type Perturbation } from "@cloudfault/core";
import { shrinkSequence, type SequenceShrinkResult } from "./shrink.js";

export interface ModelShrinkOptions<Model, Command> {
  initialModel: () => Model;
  precondition(command: Command, model: Model): boolean;
  apply(command: Command, model: Model): Model;
}

export interface ValidatedCommandSequence<Model, Command> {
  valid: boolean;
  finalModel?: Model;
  failedAt?: number;
  command?: Command;
}

export function validateCommandSequence<Model, Command>(
  commands: readonly Command[],
  options: ModelShrinkOptions<Model, Command>,
): ValidatedCommandSequence<Model, Command> {
  let model = options.initialModel();
  for (let index = 0; index < commands.length; index += 1) {
    const command = commands[index]!;
    if (!options.precondition(command, model)) return { valid: false, failedAt: index, command };
    model = options.apply(command, model);
  }
  return { valid: true, finalModel: model };
}

export async function shrinkModelCommands<Model, Command>(
  commands: readonly Command[],
  options: ModelShrinkOptions<Model, Command>,
  reproduces: (commands: readonly Command[]) => boolean | Promise<boolean>,
): Promise<SequenceShrinkResult<Command>> {
  return shrinkSequence(commands, async (candidate) => {
    if (!validateCommandSequence(candidate, options).valid) return false;
    return reproduces(candidate);
  });
}

export interface ModelCounterexampleShrinkResult<Command> {
  perturbations: readonly Perturbation[];
  commands: readonly Command[];
  faultAttempts: number;
  commandAttempts: number;
  rounds: number;
}

export async function shrinkModelCounterexample<Model, Command>(
  perturbations: readonly Perturbation[],
  commands: readonly Command[],
  model: ModelShrinkOptions<Model, Command>,
  reproduces: (input: { perturbations: readonly Perturbation[]; commands: readonly Command[] }) => boolean | Promise<boolean>,
  options: { maxRounds?: number } = {},
): Promise<ModelCounterexampleShrinkResult<Command>> {
  let currentFaults = [...perturbations];
  let currentCommands = [...commands];
  let faultAttempts = 0;
  let commandAttempts = 0;
  let rounds = 0;
  const maxRounds = Math.max(1, options.maxRounds ?? 4);

  if (!validateCommandSequence(currentCommands, model).valid) throw new Error("Initial command sequence violates model preconditions");
  if (!(await reproduces({ perturbations: currentFaults, commands: currentCommands }))) throw new Error("Initial model counterexample does not reproduce");

  while (rounds < maxRounds) {
    rounds++;
    const beforeFaults = currentFaults.length;
    const beforeCommands = currentCommands.length;
    const minimizedFaults = await minimizeFailureSet(currentFaults, (candidate) => reproduces({ perturbations: candidate, commands: currentCommands }));
    currentFaults = [...minimizedFaults.minimal];
    faultAttempts += minimizedFaults.attempts;
    const minimizedCommands = await shrinkModelCommands(currentCommands, model, (candidate) => reproduces({ perturbations: currentFaults, commands: candidate }));
    currentCommands = [...minimizedCommands.minimal];
    commandAttempts += minimizedCommands.attempts;
    if (currentFaults.length === beforeFaults && currentCommands.length === beforeCommands) break;
  }

  return { perturbations: currentFaults, commands: currentCommands, faultAttempts, commandAttempts, rounds };
}
