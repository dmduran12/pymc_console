import{c,j as t}from"./index-982_qNvm.js";import{c as l,b as g}from"./recharts-CHDYrIv-.js";/**
 * @license lucide-react v0.559.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const p=[["path",{d:"M2 20h.01",key:"4haj6o"}],["path",{d:"M7 20v-4",key:"j294jx"}],["path",{d:"M12 20v-8",key:"i3yub9"}],["path",{d:"M17 20V8",key:"1tkaf5"}]],m=c("signal-high",p);/**
 * @license lucide-react v0.559.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const f=[["path",{d:"M2 20h.01",key:"4haj6o"}],["path",{d:"M7 20v-4",key:"j294jx"}]],j=c("signal-low",f);/**
 * @license lucide-react v0.559.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const y=[["path",{d:"M2 20h.01",key:"4haj6o"}],["path",{d:"M7 20v-4",key:"j294jx"}],["path",{d:"M12 20v-8",key:"i3yub9"}]],k=c("signal-medium",y);/**
 * @license lucide-react v0.559.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const v=[["path",{d:"M2 20h.01",key:"4haj6o"}]],N=c("signal-zero",v);/**
 * @license lucide-react v0.559.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const M=[["path",{d:"M2 20h.01",key:"4haj6o"}],["path",{d:"M7 20v-4",key:"j294jx"}],["path",{d:"M12 20v-8",key:"i3yub9"}],["path",{d:"M17 20V8",key:"1tkaf5"}],["path",{d:"M22 4v16",key:"sih9yq"}]],w=c("signal",M);function d(e){return e>=-90?"excellent":e>=-100?"good":e>=-110?"fair":e>=-120?"weak":"poor"}function b(e){switch(e){case"excellent":return"text-accent-success";case"good":return"text-[#71F8E5]";case"fair":return"text-[#F9D26F]";case"weak":return"text-[#FB923C]";case"poor":return"text-accent-danger";default:return"text-text-muted"}}function h(e,a){if(!a)return"bg-white/10";switch(e){case"excellent":return"bg-accent-success";case"good":return"bg-[#71F8E5]";case"fair":return"bg-[#F9D26F]";case"weak":return"bg-[#FB923C]";case"poor":return"bg-accent-danger";default:return"bg-white/20"}}function C({rssi:e,className:a="w-4 h-4"}){const o=d(e),r=b(o),n=l(r,a);switch(o){case"excellent":return t.jsx(w,{className:n});case"good":return t.jsx(m,{className:n});case"fair":return t.jsx(k,{className:n});case"weak":return t.jsx(j,{className:n});case"poor":default:return t.jsx(N,{className:n})}}function S({rssi:e,snr:a,compact:o=!1,showValues:r=!0}){const n=d(e),i=4,x={excellent:4,good:3,fair:2,weak:1,poor:0}[n];return o?t.jsxs("div",{className:"flex items-center justify-end gap-1.5",children:[r&&t.jsx("span",{className:"text-[10px] font-mono text-text-secondary",children:e}),t.jsx("div",{className:"flex items-end gap-[2px] h-3",children:Array.from({length:i}).map((u,s)=>t.jsx("div",{className:l("w-[3px] rounded-[1px] transition-colors",h(n,s<x)),style:{height:`${(s+1)/i*100}%`}},s))})]}):t.jsxs("div",{className:"flex items-center justify-end gap-2",children:[r&&t.jsxs("div",{className:"flex flex-col items-end",children:[t.jsxs("span",{className:"text-xs font-mono text-text-secondary leading-tight",children:[e," dBm"]}),a!==void 0&&t.jsxs("span",{className:"text-[10px] font-mono text-text-muted leading-tight",children:[a.toFixed(1)," dB"]})]}),t.jsx("div",{className:"flex items-end gap-[2px] h-3.5",children:Array.from({length:i}).map((u,s)=>t.jsx("div",{className:l("w-[3px] rounded-[1px] transition-colors",h(n,s<x)),style:{height:`${(s+1)/i*100}%`}},s))})]})}const B=g.memo(S);function $(e){const a=d(e);return a.charAt(0).toUpperCase()+a.slice(1)}export{B as S,C as a,$ as g};
