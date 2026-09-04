import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  EditorPluginContext,
  PluginPresentationDismissReason,
  PluginPresentationHandle,
  PluginPresentationOptions,
} from '@mdink/web';

export type ReactPresentationOptions = Omit<
  PluginPresentationOptions,
  'element' | 'onDismiss'
> & {
  className?: string;
  onDismiss?: (reason: PluginPresentationDismissReason) => void;
};

export interface ReactPresentationHandle {
  readonly presentation: PluginPresentationHandle;
  readonly element: HTMLDivElement;
  render(node: ReactNode): void;
  update(options: ReactPresentationOptions): void;
  dismiss(reason?: PluginPresentationDismissReason): void;
}

/** Render React-owned UI through the framework-neutral plugin presentation lifecycle. */
export function createReactPresentation(
  context: EditorPluginContext,
  name: string,
  node: ReactNode,
  options: ReactPresentationOptions = {},
): ReactPresentationHandle {
  const element = document.createElement('div');
  if (options.className) element.className = options.className;
  const root = createRoot(element);
  let mounted = true;
  let current = { ...options };
  const unmount = (reason: PluginPresentationDismissReason) => {
    if (!mounted) return;
    mounted = false;
    current.onDismiss?.(reason);
    // A plugin can dismiss from inside a React event. Deferring avoids asking React to
    // synchronously unmount the root while it is still dispatching that event.
    queueMicrotask(() => root.unmount());
  };
  root.render(node);
  const presentation = context.showPresentation(name, {
    ...options,
    element,
    onDismiss: unmount,
  });
  return {
    presentation,
    element,
    render(next) {
      if (mounted) root.render(next);
    },
    update(next) {
      if (!mounted) return;
      current = { ...current, ...next };
      element.className = current.className ?? '';
      presentation.update({ ...current, element, onDismiss: unmount });
    },
    dismiss(reason = 'programmatic') {
      presentation.dismiss(reason);
    },
  };
}

/** Keep a plugin presentation mounted for the lifetime of a React component. */
export function usePluginPresentation(
  context: EditorPluginContext | null,
  name: string,
  node: ReactNode,
  options: ReactPresentationOptions = {},
): ReactPresentationHandle | null {
  const mount = useRef<ReactPresentationHandle | null>(null);
  const [handle, setHandle] = useState<ReactPresentationHandle | null>(null);
  const latestNode = useRef(node);
  const latestOptions = useRef(options);
  latestNode.current = node;
  latestOptions.current = options;

  useEffect(() => {
    if (!context) return undefined;
    const active = createReactPresentation(context, name, latestNode.current, latestOptions.current);
    mount.current = active;
    setHandle(active);
    return () => {
      active.dismiss('plugin-removed');
      if (mount.current === active) {
        mount.current = null;
        setHandle(null);
      }
    };
  }, [context, name]);

  useEffect(() => {
    mount.current?.render(node);
  }, [node]);

  useEffect(() => {
    mount.current?.update(options);
  }, [options]);

  return handle;
}
