// Minimal types for react-test-renderer.
//
// The package ships no types and `@types/react-test-renderer` is not installed —
// adding a dependency for a test helper is not worth it, and this repo's install
// is guarded (see scripts/check-no-billing-deps.js). Only the surface the map
// control tests actually use is declared, so an unsupported call fails to
// compile rather than silently becoming `any`.
declare module "react-test-renderer" {
  import type * as React from "react";

  export interface ReactTestInstance {
    type: unknown;
    props: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    parent: ReactTestInstance | null;
    children: Array<ReactTestInstance | string>;
    find(predicate: (node: ReactTestInstance) => boolean): ReactTestInstance;
    findAll(
      predicate: (node: ReactTestInstance) => boolean,
      options?: { deep?: boolean },
    ): ReactTestInstance[];
    findByType(type: unknown): ReactTestInstance;
    findAllByType(type: unknown, options?: { deep?: boolean }): ReactTestInstance[];
  }

  export interface ReactTestRenderer {
    root: ReactTestInstance;
    toJSON(): unknown;
    unmount(): void;
    update(element: React.ReactElement): void;
  }

  export function create(element: React.ReactElement): ReactTestRenderer;
  export function act(callback: () => void | Promise<void>): void;

  const _default: {
    create: typeof create;
    act: typeof act;
  };
  export default _default;
}
