import { del, get, set } from 'object-path';
import { ActorRef, assign, createMachine, send, spawn } from 'xstate';
import { choose, pure } from 'xstate/lib/actions';
import * as actor from './actor';
import { ActorState, Submitter, Validator } from './types';

export type Ctx<T extends object = any, D = any, E = any, FE = any> = {
  data?: D;
  values: T;
  error?: E | null;
  failureCount: number;
  dataUpdatedAt?: number;
  errorUpdatedAt?: number;
  errors: Record<string, FE>;
  __validationMarker: Set<string>;
  states: Record<string, ActorState>;
  actors: Record<string, ActorRef<any>>;
};

export type Events =
  | { type: 'reset' }
  | { type: 'kill'; id: string }
  | { type: 'submit' | 'cancel' }
  | { type: 'set'; id: string; value: unknown }
  | { type: 'validate'; id: string; value?: any }
  | { type: 'spawn'; id: string; value: unknown; onValidate: Validator }

  // actor events
  | { id: string; type: 'actor_error'; error: unknown }
  | { id: string; type: 'actor_success'; value: unknown }
  | { id: string; type: 'actor_validating' | 'actor_idle' };

export type States = {
  value: 'idle' | 'validating' | 'error' | 'submitting' | 'submitted';
  context: Ctx;
};

// export type SetType<T extends object, E> =
//   | { name: 'data'; value: Ctx<T, E>['data'] }
//   | { name: 'error'; value: Ctx<T, E>['error'] };
//   | { name: "values"; value: Required<Ctx<T, E>["values"]> };
//   | { name: "errors"; value: Required<Ctx<T, E>["errors"]> }

const setState = (state: ActorState) => {
  return assign<Ctx, Events>({
    states: ({ states }, { id }: any) => {
      set(states, id, state);
      return states;
    },
  });
};

export const machine = <T extends object, TErrors extends object>({
  onSubmit,
  initialValues = {} as T,
  initialErrors = {} as TErrors,
}: {
  initialValues?: T;
  onSubmit: Submitter<T>;
  initialErrors?: TErrors;
}) => {
  return createMachine<Ctx<T>, Events, States>(
    {
      initial: 'idle',

      context: {
        actors: {},
        states: {},
        failureCount: 0,
        dataUpdatedAt: 0,
        errorUpdatedAt: 0,
        errors: initialErrors,
        values: initialValues,
        __validationMarker: new Set(),
      },

      on: {
        submit: [
          {
            target: 'validating',
            cond: (c) => Object.values(c.actors).length > 0,
          },
          {
            target: 'submitting',
          },
        ],

        reset: {
          target: 'idle',
          actions: [
            pure(({ actors }: any) => {
              return Object.keys(actors).map((to) => {
                return send('reset', { to });
              });
            }),
            assign({
              data: (_) => null,
              error: (_) => null,
              failureCount: (_) => 0,
              dataUpdatedAt: (_) => 0,
              errorUpdatedAt: (_) => 0,
              errors: (_) => initialErrors,
              values: (_) => initialValues,
            }),
          ],
        },

        set: {
          actions: [
            'setValue',
            'removeActorError',
            choose([
              {
                cond: 'has_actor',
                actions: send((_, { value }) => ({ type: 'change', value }), {
                  to: (_, { id }) => id,
                }),
              },
            ]),
          ],
        },

        validate: {
          cond: 'has_actor',
          actions: [
            'removeActorError',
            send(
              ({ values }, { value }) => ({ type: 'validate', value, values }),
              { to: (_, { id }) => id }
            ),
          ],
        },

        spawn: {
          actions: 'spawnActor',
        },

        kill: {
          cond: 'has_actor',
          actions: ['killActor', 'removeState'],
        },

        actor_idle: {
          actions: 'setInitialState',
        },

        actor_success: {
          actions: ['maybeSetValue', 'setSuccessState'],
        },

        actor_error: {
          actions: ['setActorError', 'setErrorState'],
        },

        actor_validating: {
          actions: 'setValidatingState',
        },
      },

      states: {
        idle: {},

        validating: {
          exit: assign({
            __validationMarker: (_) => new Set(),
          }),

          entry: pure(({ actors, values }: any) => {
            return Object.keys(actors).map((to) => {
              return send({ values, type: 'validate' }, { to });
            });
          }),

          always: [
            {
              target: 'idle',
              cond: (c) => {
                return (
                  Object.values(c.errors).length > 0 &&
                  c.__validationMarker.size >= Object.keys(c.actors).length
                );
              },
            },
            {
              target: 'submitting',
              cond: (c) => {
                return (
                  c.__validationMarker.size >= Object.keys(c.actors).length
                );
              },
            },
          ],

          on: {
            cancel: 'idle',

            actor_error: {
              actions: ['setActorError', 'mark', 'setErrorState'],
            },

            actor_success: {
              actions: [
                'maybeSetValue',
                'removeActorError',
                'mark',
                'setSuccessState',
              ],
            },
          },
        },

        submitting: {
          on: {
            cancel: 'idle',

            '*': undefined,
          },

          // entry: [
          //   'clearError',
          //   assign({
          //     data: (_) => null,
          //     error: (_) => null,
          //   }),
          // ],

          invoke: {
            src: 'submit',

            onError: {
              target: 'error',
              actions: assign({
                error: (_, { data }) => data,
                errorUpdatedAt: (_) => Date.now(),
              }),
            },

            onDone: {
              target: 'submitted',
              actions: assign({
                data: (_, { data }) => data,
                dataUpdatedAt: (_) => Date.now(),
              }),
            },
          },
        },

        submitted: {
          entry: assign({
            failureCount: (_) => 0,
          }),
        },

        error: {
          entry: assign({
            failureCount: (ctx) => ctx.failureCount + 1,
          }),

          exit: 'clearError',
        },
      },
    },
    {
      guards: {
        has_actor: ({ actors }, { id }: any) => id in actors,
      },
      actions: {
        clearError: assign({ error: (_) => null }),

        setValue: assign({
          values: ({ values }, { id, value }: any) => {
            set(values, id, value);
            return values;
          },
        }),

        maybeSetValue: assign({
          values: ({ values }, { id, value }: any) => {
            set(values, id, value === undefined ? get(values, id) : value);
            return values;
          },
        }),

        setActorError: assign({
          errors: ({ errors }, { id, error }: any) => {
            set(errors, id, error);
            return errors;
          },
        }),

        removeActorError: assign({
          errors: ({ errors }, { id }: any) => del(errors, id),
        }),

        mark: assign({
          __validationMarker: ({ __validationMarker }, { id }: any) => {
            return __validationMarker.add(id);
          },
        }),

        setError: assign({
          error: (_, { data }: any) => data,
        }),

        setInitialState: setState('idle'),

        setSuccessState: setState('success'),

        setErrorState: setState('error'),

        setValidatingState: setState('validating'),

        removeState: assign({
          states: ({ states }, { id }: any) => del(states, id),
        }),

        spawnActor: assign({
          values: ({ values }, { id, value }: any) => {
            set(values, id, value ?? get(initialValues, id));
            return values;
          },
          actors: ({ actors }, { id, value, onValidate }: any) => {
            const error = get(initialErrors, id);
            const v = value ?? get(initialValues, id);

            const spawned = spawn(
              actor.actor({ id, value: v, error, onValidate }),
              id
            );

            return { ...actors, [id]: spawned };
          },
        }),

        killActor: assign({
          actors: ({ actors }, { id }: any) => {
            actors[id].stop?.();
            delete actors[id];
            return actors;
          },
        }),
      },
      services: {
        submit: async ({ values }) => {
          const res = onSubmit(values);
          return res instanceof Promise ? await res : res;
        },
      },
    }
  );
};
