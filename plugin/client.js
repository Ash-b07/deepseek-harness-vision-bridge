window.__ModuleLoader__.load({
  id: 'vision-bridge',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const {
      Button,
      Menu,
      IconEnhanceOutline16,
      IconRefreshOutline16,
    } = require('@deepseek-ai/dsh-client-ui-primitives');

    const NS = 'vision-bridge';
    const zh = {
      title: '视觉增强',
      enabled: '已开启',
      disabled: '已关闭',
      enable: '开启视觉增强',
      disable: '关闭视觉增强',
      loading: '正在读取多模态模型…',
      empty: '没有发现声明支持图片的模型',
      refresh: '刷新模型目录',
      description: '图片先由这里选择的多模态模型理解，再交给当前主模型继续推理。',
      unavailable: '设置暂不可用',
    };
    const en = {
      title: 'Vision',
      enabled: 'On',
      disabled: 'Off',
      enable: 'Enable vision',
      disable: 'Disable vision',
      loading: 'Loading multimodal models…',
      empty: 'No image-capable model is declared',
      refresh: 'Refresh model catalog',
      description: 'Images are understood by this model before the current main model continues reasoning.',
      unavailable: 'Settings unavailable',
    };

    const css = `
      .visionBridgeTrigger{max-width:190px;color:var(--dsw-alias-label-secondary)}
      .visionBridgeTrigger[data-enabled="true"]{color:var(--dsw-alias-label-primary)}
      .visionBridgeTriggerLabel{max-width:130px;text-overflow:ellipsis;white-space:nowrap;overflow:hidden}
      .visionBridgeRow{width:100%;min-height:68px;border-bottom:1px solid var(--dsw-alias-border-l3);display:flex;align-items:center;justify-content:space-between;gap:20px;padding:14px 0}
      .visionBridgeCopy{min-width:0;display:flex;flex-direction:column;gap:3px}
      .visionBridgeTitle{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px}
      .visionBridgeDescription{max-width:520px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
      .visionBridgeState{color:var(--dsw-alias-label-caption);font-size:12px}
    `;
    if (typeof document !== 'undefined' && !document.querySelector('style[data-plugin-css="vision-bridge/client"]')) {
      const style = document.createElement('style');
      style.dataset.plugin = 'vision-bridge';
      style.dataset.pluginCss = 'vision-bridge/client';
      style.textContent = css;
      document.head.appendChild(style);
    }

    class VisionRuntime {
      constructor(ctx) {
        this.ctx = ctx;
        this.scope = ctx.settingsScope.bind({ namespace: NS });
        this.listeners = new Set();
        this.models = { status: 'idle', groups: [], error: null };
        this.snapshot = this.compose();
        this.scope.subscribe(() => this.publish());
        const refresh = () => this.load().catch(() => {});
        ctx.remote.$on('llm/adapters-updated', refresh);
        ctx.remote.$on('settings/document-updated', (namespace) => {
          if (namespace === NS) this.publish();
        });
        this.load().catch(() => {});
      }

      compose() {
        return { settings: this.scope.getSnapshot(), models: this.models };
      }

      publish() {
        this.snapshot = this.compose();
        for (const listener of this.listeners) listener();
      }

      subscribe = (listener) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      };

      getSnapshot = () => this.snapshot;

      async load() {
        this.models = { ...this.models, status: 'loading', error: null };
        this.publish();
        // rc.6 内置客户端 schema 尚无 inputModalities，会把 Host 新增字段剥掉。
        // 这里读取同源 RPC 的原始 JSON；仍走同一个 Host API，不接触任何外部地址。
        let result;
        try {
          const response = await fetch('/api/llm.models', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type: 'client-request',
              rpcId: `vision-models-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              method: 'llm.models',
              payload: {},
            }),
          });
          if (!response.ok) throw new Error(`llm.models HTTP ${response.status}`);
          ({ result } = await response.json());
        } catch (error) {
          this.models = {
            ...this.models,
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
          };
          this.publish();
          return;
        }
        if (!result?.ok) {
          const remoteError = result?.error ?? { code: 'bad-response', message: 'llm.models 返回格式无效' };
          this.models = {
            ...this.models,
            status: 'error',
            error: `${remoteError.code}: ${remoteError.message}`,
          };
          this.publish();
          return;
        }
        this.models = {
          status: 'ready',
          groups: result.value.groups
            .filter((group) => group.id !== 'vision-bridge')
            .map((group) => ({
              ...group,
              models: group.models.filter((model) => model.inputModalities?.includes('image')),
            }))
            .filter((group) => group.models.length > 0),
          error: result.value.failures?.length
            ? result.value.failures.map((failure) => `${failure.name}: ${failure.message}`).join('\n')
            : null,
        };
        this.publish();
      }

      async toggle() {
        const enabled = this.scope.getSnapshot().value?.enabled === true;
        await this.scope.set('enabled', !enabled);
      }

      async select(route) {
        await this.scope.set('route', route);
        if (this.scope.getSnapshot().value?.enabled !== true) await this.scope.set('enabled', true);
      }
    }

    function useVision(runtime) {
      return React.useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot);
    }

    function routeId(provider, model) {
      return `route:${encodeURIComponent(provider)}:${encodeURIComponent(model)}`;
    }

    function pickerItems(snapshot, t) {
      const items = [];
      const enabled = snapshot.settings.value?.enabled === true;
      items.push({ id: 'toggle', label: enabled ? t('disable') : t('enable') });
      items.push({ type: 'separator', id: 'toggle-separator' });
      if (snapshot.models.status === 'loading' && snapshot.models.groups.length === 0) {
        items.push({ id: 'loading', label: t('loading'), disabled: true });
      } else if (snapshot.models.groups.length === 0) {
        items.push({ id: 'empty', label: t('empty'), disabled: true });
      } else {
        for (const group of snapshot.models.groups) {
          items.push({ type: 'label', id: `group:${group.id}`, text: group.name });
          for (const model of group.models) {
            items.push({ id: routeId(group.id, model.id), label: model.name });
          }
        }
      }
      return items;
    }

    function VisionPicker({ runtime, t, side = 'top', compact = false }) {
      const snapshot = useVision(runtime);
      const [open, setOpen] = React.useState(false);
      const value = snapshot.settings.value;
      const route = value?.route;
      const enabled = value?.enabled === true;
      const selected = route?.provider && route?.model ? routeId(route.provider, route.model) : undefined;
      const currentName = snapshot.models.groups
        .flatMap((group) => group.models)
        .find((model) => route && snapshot.models.groups.some((group) => group.id === route.provider && group.models.includes(model) && model.id === route.model))?.name;
      const label = enabled ? currentName ?? route?.model ?? t('enabled') : t('disabled');
      const items = pickerItems(snapshot, t);
      const routes = new Map();
      for (const group of snapshot.models.groups) {
        for (const model of group.models) routes.set(routeId(group.id, model.id), { provider: group.id, model: model.id });
      }
      return React.createElement(Menu, {
        open,
        items,
        selectedId: selected,
        side,
        align: compact ? 'start' : 'end',
        portal: true,
        dense: true,
        footer: [{ id: 'refresh', label: t('refresh'), icon: React.createElement(IconRefreshOutline16, { size: 16 }) }],
        onClose: () => setOpen(false),
        onSelect: (id) => {
          if (id === 'toggle') runtime.toggle().catch(() => {});
          else if (id === 'refresh') runtime.load().catch(() => {});
          else {
            const next = routes.get(id);
            if (next) runtime.select(next).catch(() => {});
          }
          setOpen(false);
        },
        anchor: React.createElement(
          Button,
          {
            type: 'button',
            variant: 'toolbar',
            size: 'sm',
            icon: React.createElement(IconEnhanceOutline16, { size: 16 }),
            className: 'visionBridgeTrigger',
            'data-enabled': String(enabled),
            disabled: snapshot.settings.status !== 'ready',
            title: `${t('title')} · ${label}`,
            onClick: () => setOpen((state) => !state),
          },
          React.createElement('span', { className: 'visionBridgeTriggerLabel' }, compact ? t('title') : label),
        ),
      });
    }

    function VisionSettingsRow({ runtime, t }) {
      const snapshot = useVision(runtime);
      const enabled = snapshot.settings.value?.enabled === true;
      return React.createElement(
        'div',
        { className: 'visionBridgeRow' },
        React.createElement(
          'div',
          { className: 'visionBridgeCopy' },
          React.createElement('div', { className: 'visionBridgeTitle' }, t('title')),
          React.createElement('div', { className: 'visionBridgeDescription' }, t('description')),
          React.createElement('div', { className: 'visionBridgeState' }, enabled ? t('enabled') : t('disabled')),
        ),
        React.createElement(VisionPicker, { runtime, t, side: 'bottom' }),
      );
    }

    const inject = ['slots', 'locale', 'settingsScope', 'connection', 'remote'];
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'vision-bridge: dictionaries');
      const t = ctx.locale.bind(NS);
      const runtime = new VisionRuntime(ctx);
      ctx.slots.inject('conversation.input.left', () =>
        ctx.slots.register(
          { name: 'conversation.input.left', id: 'vision-bridge', order: 40, locale: NS },
          () => React.createElement(VisionPicker, { runtime, t, compact: true, side: 'top' }),
        ),
      );
      ctx.slots.inject('settings.general.item', () =>
        ctx.slots.register(
          { name: 'settings.general.item', id: 'vision-bridge', order: 35, locale: NS },
          () => React.createElement(VisionSettingsRow, { runtime, t }),
        ),
      );
    }

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
