import type {
  GenericValidator,
  ObjectType,
  PropertyValidators,
} from "convex/values";

import type { ActionCtx, MutationCtx, QueryCtx } from "../_generated/server";

type ReturnsValidator = GenericValidator | PropertyValidators;

type FunctionDefinition<
  Ctx,
  Args extends PropertyValidators,
  ReturnValue,
  Returns extends ReturnsValidator | undefined,
> = {
  args: Args;
  returns?: Returns;
  handler: (ctx: Ctx, args: ObjectType<Args>) => ReturnValue;
};

/** Contextually type a Convex function definition without registering it. */
export function defineQuery<
  const Args extends PropertyValidators,
  ReturnValue,
  Returns extends ReturnsValidator | undefined = undefined,
>(
  definition: FunctionDefinition<QueryCtx, Args, ReturnValue, Returns>,
): FunctionDefinition<QueryCtx, Args, ReturnValue, Returns> {
  return definition;
}

/** Contextually type a Convex function definition without registering it. */
export function defineMutation<
  const Args extends PropertyValidators,
  ReturnValue,
  Returns extends ReturnsValidator | undefined = undefined,
>(
  definition: FunctionDefinition<MutationCtx, Args, ReturnValue, Returns>,
): FunctionDefinition<MutationCtx, Args, ReturnValue, Returns> {
  return definition;
}

/** Contextually type a Convex function definition without registering it. */
export function defineAction<
  const Args extends PropertyValidators,
  ReturnValue,
  Returns extends ReturnsValidator | undefined = undefined,
>(
  definition: FunctionDefinition<ActionCtx, Args, ReturnValue, Returns>,
): FunctionDefinition<ActionCtx, Args, ReturnValue, Returns> {
  return definition;
}
