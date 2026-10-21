/**
 * dsh-judge 浏览器半：在「插件 → dsh-judge」详情页里渲染配置表单。
 *
 * 手写 __ModuleLoader__ bundle（无需构建），数据走宿主内嵌的同源 API
 * `/dsh-judge/api/config`（由 index.js 的 webServer 路由提供）。
 */
window.__ModuleLoader__.load({
  id: "dsh-judge",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const React = require("react");
    const h = React.createElement;
    const API = "/dsh-judge/api/config";

    const css =
      ".dj-wrap{display:flex;flex-direction:column;gap:14px;font-size:14px;line-height:1.6;color:var(--dsw-alias-label-primary,#e6e8ee)}" +
      ".dj-sec{border:1px solid var(--dsw-alias-border-l2,#2a2e38);border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:10px}" +
      ".dj-sec h4{margin:0;font-size:14px;font-weight:600}" +
      ".dj-row{display:flex;align-items:center;gap:12px;justify-content:space-between}" +
      ".dj-row>label{flex:none;min-width:180px;color:var(--dsw-alias-label-secondary,#b8bcc9)}" +
      ".dj-row>label small{display:block;color:var(--dsw-alias-label-tertiary,#8b90a0);font-size:11px;font-weight:400}" +
      ".dj-in{flex:1;max-width:360px;background:var(--dsw-alias-bg-module-platform,#1a1d24);border:1px solid var(--dsw-alias-border-l2,#2a2e38);border-radius:8px;color:inherit;padding:6px 10px;font-size:13px}" +
      ".dj-err{color:#f0a0a0;font-size:12px}" +
      ".dj-ok{color:#7bdca8;font-size:12px}" +
      ".dj-bar{display:flex;align-items:center;gap:12px}" +
      ".dj-btn{background:#4f8cff;border:none;color:#fff;padding:6px 18px;border-radius:8px;cursor:pointer;font-size:13px}" +
      ".dj-btn:disabled{opacity:.5;cursor:default}" +
      ".dj-muted{color:var(--dsw-alias-label-tertiary,#8b90a0);font-size:12px}" +
      ".dj-sw{width:44px;height:24px;flex:none;cursor:pointer;position:relative;display:inline-block}" +
      ".dj-sw input{display:none}" +
      ".dj-sw i{position:absolute;inset:0;background:#3a3f4d;border-radius:12px;transition:.2s}" +
      ".dj-sw i:before{content:'';position:absolute;width:18px;height:18px;left:3px;top:3px;background:#fff;border-radius:50%;transition:.2s}" +
      ".dj-sw input:checked+i{background:#3fb97c}" +
      ".dj-sw input:checked+i:before{transform:translateX(20px)}";

    const STYLE_ID = "dsh-judge/styles";
    if (typeof document !== "undefined" && document.querySelector('style[data-plugin-css="' + STYLE_ID + '"]') === null) {
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-judge";
      tag.dataset.pluginCss = STYLE_ID;
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    function Switch(props) {
      return h("label", { className: "dj-sw" },
        h("input", { type: "checkbox", checked: !!props.on, onChange: (e) => props.onChange(e.target.checked) }),
        h("i", null));
    }

    function Num(props) {
      return h("input", {
        className: "dj-in",
        type: "number",
        min: props.min,
        step: props.step || 1,
        value: props.value,
        onChange: (e) => props.onChange(Number(e.target.value)),
      });
    }

    function Text(props) {
      return h("input", {
        className: "dj-in",
        type: "text",
        value: props.value ?? "",
        placeholder: props.placeholder || "",
        onChange: (e) => props.onChange(e.target.value),
      });
    }

    function Row(props) {
      return h("div", { className: "dj-row" },
        h("label", null, props.label, props.hint ? h("small", null, props.hint) : null),
        props.children);
    }

    function Section(props) {
      return h("div", { className: "dj-sec" }, h("h4", null, props.title), props.children);
    }

    function ConfigPanel() {
      const [state, setState] = React.useState(null);
      const [error, setError] = React.useState("");
      const [saved, setSaved] = React.useState("");
      const [busy, setBusy] = React.useState(false);

      function load() {
        fetch(API, { cache: "no-store" })
          .then((r) => r.json())
          .then((d) => { if (d.ok) { setState(d.config); setError(""); } else setError(d.message || "读取失败"); })
          .catch((e) => setError("读取失败: " + e));
      }
      React.useEffect(load, []);

      function set(key, value) {
        setState((prev) => (prev ? { ...prev, [key]: value } : prev));
        setSaved("");
      }
      function setJev(key, value) {
        setState((prev) => (prev ? { ...prev, jev: { ...prev.jev, [key]: value } } : prev));
        setSaved("");
      }
      function save() {
        setBusy(true);
        fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ config: state }) })
          .then((r) => r.json())
          .then((d) => {
            if (d.ok) { setState(d.config); setSaved("已保存并立即生效（不需要重启）"); }
            else setError(d.message || "保存失败");
          })
          .catch((e) => setError("保存失败: " + e))
          .finally(() => setBusy(false));
      }

      if (!state) {
        return h("div", { className: "dj-wrap" },
          h("div", { className: "dj-muted" }, error || "加载配置…"));
      }

      return h("div", { className: "dj-wrap" },
        h(Section, { title: "总开关" },
          h(Row, { label: "启用审判员", hint: "关闭后不再拦截答案" },
            h(Switch, { on: state.enabled, onChange: (v) => set("enabled", v) })),
          h(Row, { label: "dryRun（只判定不驳回）", hint: "观察期用；不打断回答，只记录" },
            h(Switch, { on: state.dryRun, onChange: (v) => set("dryRun", v) }))),

        h(Section, { title: "驳回预算" },
          h(Row, { label: "maxAttempts", hint: "同一轮最多驳回几次" },
            h(Num, { value: state.maxAttempts, min: 0, onChange: (v) => set("maxAttempts", v) })),
          h(Row, { label: "sessionRejectBudget", hint: "整个会话累计驳回上限，超出后只判定不打断" },
            h(Num, { value: state.sessionRejectBudget, min: 0, onChange: (v) => set("sessionRejectBudget", v) })),
          h(Row, { label: "minAnswerChars", hint: "太短的答案直接跳过" },
            h(Num, { value: state.minAnswerChars, min: 0, onChange: (v) => set("minAnswerChars", v) }))),

        h(Section, { title: "审判模型" },
          h(Row, { label: "judgeProvider", hint: "留空 = 跟随当前会话" },
            h(Text, { value: state.judgeProvider, onChange: (v) => set("judgeProvider", v) })),
          h(Row, { label: "judgeModel", hint: "留空 = 跟随当前会话" },
            h(Text, { value: state.judgeModel, onChange: (v) => set("judgeModel", v) })),
          h(Row, { label: "judgeMaxTokens", hint: "审判输出上限（推理也计入）" },
            h(Num, { value: state.judgeMaxTokens, min: 500, step: 500, onChange: (v) => set("judgeMaxTokens", v) })),
          h(Row, { label: "transcriptChars", hint: "送审转录预算（字符）" },
            h(Num, { value: state.transcriptChars, min: 2000, step: 1000, onChange: (v) => set("transcriptChars", v) })),
          h(Row, { label: "toolResultChars", hint: "单条工具结果保留长度" },
            h(Num, { value: state.toolResultChars, min: 200, step: 100, onChange: (v) => set("toolResultChars", v) }))),

        h(Section, { title: "Jev 预筛（TypeSafe）" },
          h(Row, { label: "启用 Jev", hint: "低风险直接放行，高风险才调大模型审判" },
            h(Switch, { on: state.jev.enabled, onChange: (v) => setJev("enabled", v) })),
          h(Row, { label: "模型", hint: "推荐 jev-latest（实际 jev-1.13.0）" },
            h(Text, { value: state.jev.model, onChange: (v) => setJev("model", v) })),
          h(Row, { label: "代理", hint: "直连被区域限制（451），填本地代理" },
            h(Text, { value: state.jev.proxyUrl, placeholder: "http://127.0.0.1:10809", onChange: (v) => setJev("proxyUrl", v) })),
          h(Row, { label: "riskThreshold", hint: "风险概率 ≥ 该值才升级大模型审判（0.5 起点）" },
            h(Num, { value: state.jev.riskThreshold, min: 0.05, step: 0.05, onChange: (v) => setJev("riskThreshold", v) })),
          h(Row, { label: "失败策略", hint: "judge = 回退大模型审判；pass = 放行" },
            h(Text, { value: state.jev.onError, onChange: (v) => setJev("onError", v) }))),

        h("div", { className: "dj-bar" },
          h("button", { className: "dj-btn", disabled: busy, onClick: save }, busy ? "保存中…" : "保存"),
          saved ? h("span", { className: "dj-ok" }, saved) : null,
          error ? h("span", { className: "dj-err" }, error) : null));
    }

    function apply(ctx) {
      ctx.slots.inject("plugins.bundle.config", () =>
        ctx.slots.register({ name: "plugins.bundle.config", key: "dsh-judge" }, ConfigPanel));
    }

    const inject = ["slots"];
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
