import{i as e}from"./rolldown-runtime-CNOWq4Kh.js";import{Aot as t}from"./app-iBLMol86.js";import{n,t as r}from"./hls-DLDAQuVb.js";import{n as i,t as a}from"./dist-BvrWwRr5.js";var o=e(t(),1),s=Object.create,c=Object.defineProperty,l=Object.getOwnPropertyDescriptor,u=Object.getOwnPropertyNames,d=Object.getPrototypeOf,f=Object.prototype.hasOwnProperty,p=function(e,t){return function(){return e&&(t=e(e=0)),t}},m=function(e,t){return function(){return t||e((t={exports:{}}).exports,t),t.exports}},h=function(e,t,n,r){if(t&&typeof t==`object`||typeof t==`function`)for(var i=u(t),a=0,o=i.length,s;a<o;a++)s=i[a],!f.call(e,s)&&s!==n&&c(e,s,{get:function(e){return t[e]}.bind(null,s),enumerable:!(r=l(t,s))||r.enumerable});return e},ee=function(e,t,n){return n=e==null?{}:s(d(e)),h(t||!e||!e.__esModule?c(n,`default`,{value:e,enumerable:!0}):n,e)};function te(e,t){return t!=null&&typeof Symbol<`u`&&t[Symbol.hasInstance]?!!t[Symbol.hasInstance](e):te(e,t)}var ne=p(function(){ne()});function re(e){"@swc/helpers - typeof";return e&&typeof Symbol<`u`&&e.constructor===Symbol?`symbol`:typeof e}var ie=p(function(){}),ae=m(function(e,t){var n=Array.prototype.slice;t.exports=r;function r(e,t){for((`length`in e)||(e=[e]),e=n.call(e);e.length;){var r=e.shift(),i=t(r);if(i)return i;r.childNodes&&r.childNodes.length&&(e=n.call(r.childNodes).concat(e))}}}),oe=m(function(e,t){ne(),t.exports=n;function n(e,t){if(!te(this,n))return new n(e,t);this.data=e,this.nodeValue=e,this.length=e.length,this.ownerDocument=t||null}n.prototype.nodeType=8,n.prototype.nodeName=`#comment`,n.prototype.toString=function(){return`[object Comment]`}}),se=m(function(e,t){ne(),t.exports=n;function n(e,t){if(!te(this,n))return new n(e);this.data=e||``,this.length=this.data.length,this.ownerDocument=t||null}n.prototype.type=`DOMTextNode`,n.prototype.nodeType=3,n.prototype.nodeName=`#text`,n.prototype.toString=function(){return this.data},n.prototype.replaceData=function(e,t,n){var r=this.data,i=r.substring(0,e),a=r.substring(e+t,r.length);this.data=i+n+a,this.length=this.data.length}}),ce=m(function(e,t){t.exports=n;function n(e){var t=this,n=e.type;e.target||=t,t.listeners||={};var r=t.listeners[n];if(r)return r.forEach(function(n){e.currentTarget=t,typeof n==`function`?n(e):n.handleEvent(e)});t.parentNode&&t.parentNode.dispatchEvent(e)}}),le=m(function(e,t){t.exports=n;function n(e,t){var n=this;n.listeners||={},n.listeners[e]||(n.listeners[e]=[]),n.listeners[e].indexOf(t)===-1&&n.listeners[e].push(t)}}),ue=m(function(e,t){t.exports=n;function n(e,t){var n=this;if(n.listeners&&n.listeners[e]){var r=n.listeners[e],i=r.indexOf(t);i!==-1&&r.splice(i,1)}}}),de=m(function(e,t){ie(),t.exports=r;var n=[`area`,`base`,`br`,`col`,`embed`,`hr`,`img`,`input`,`keygen`,`link`,`menuitem`,`meta`,`param`,`source`,`track`,`wbr`];function r(e){switch(e.nodeType){case 3:return u(e.data);case 8:return`<!--`+e.data+`-->`;default:return i(e)}}function i(e){var t=[],i=e.tagName;return e.namespaceURI===`http://www.w3.org/1999/xhtml`&&(i=i.toLowerCase()),t.push(`<`+i+l(e)+s(e)),n.indexOf(i)>-1?t.push(` />`):(t.push(`>`),e.childNodes.length?t.push.apply(t,e.childNodes.map(r)):e.textContent||e.innerText?t.push(u(e.textContent||e.innerText)):e.innerHTML&&t.push(e.innerHTML),t.push(`</`+i+`>`)),t.join(``)}function a(e,t){var n=re(e[t]);return t===`style`&&Object.keys(e.style).length>0||e.hasOwnProperty(t)&&(n===`string`||n===`boolean`||n===`number`)&&t!==`nodeName`&&t!==`className`&&t!==`tagName`&&t!==`textContent`&&t!==`innerText`&&t!==`namespaceURI`&&t!==`innerHTML`}function o(e){if(typeof e==`string`)return e;var t=``;return Object.keys(e).forEach(function(n){var r=e[n];n=n.replace(/[A-Z]/g,function(e){return`-`+e.toLowerCase()}),t+=n+`:`+r+`;`}),t}function s(e){var t=e.dataset,n=[];for(var r in t)n.push({name:`data-`+r,value:t[r]});return n.length?c(n):``}function c(e){var t=[];return e.forEach(function(e){var n=e.name,r=e.value;n===`style`&&(r=o(r)),t.push(n+`="`+d(r)+`"`)}),t.length?` `+t.join(` `):``}function l(e){var t=[];for(var n in e)a(e,n)&&t.push({name:n,value:e[n]});for(var r in e._attributes)for(var i in e._attributes[r]){var o=e._attributes[r][i],s=(o.prefix?o.prefix+`:`:``)+i;t.push({name:s,value:o.value})}return e.className&&t.push({name:`class`,value:e.className}),t.length?c(t):``}function u(e){var t=``;return typeof e==`string`?t=e:e&&(t=e.toString()),t.replace(/&/g,`&amp;`).replace(/</g,`&lt;`).replace(/>/g,`&gt;`)}function d(e){return u(e).replace(/"/g,`&quot;`)}}),fe=m(function(e,t){ne();var n=ae(),r=ce(),i=le(),a=ue(),o=de(),s=`http://www.w3.org/1999/xhtml`;t.exports=c;function c(e,t,n){if(!te(this,c))return new c(e);var r=n===void 0?s:n||null;this.tagName=r===s?String(e).toUpperCase():e,this.nodeName=this.tagName,this.className=``,this.dataset={},this.childNodes=[],this.parentNode=null,this.style={},this.ownerDocument=t||null,this.namespaceURI=r,this._attributes={},this.tagName===`INPUT`&&(this.type=`text`)}c.prototype.type=`DOMElement`,c.prototype.nodeType=1,c.prototype.appendChild=function(e){return e.parentNode&&e.parentNode.removeChild(e),this.childNodes.push(e),e.parentNode=this,e},c.prototype.replaceChild=function(e,t){e.parentNode&&e.parentNode.removeChild(e);var n=this.childNodes.indexOf(t);return t.parentNode=null,this.childNodes[n]=e,e.parentNode=this,t},c.prototype.removeChild=function(e){var t=this.childNodes.indexOf(e);return this.childNodes.splice(t,1),e.parentNode=null,e},c.prototype.insertBefore=function(e,t){e.parentNode&&e.parentNode.removeChild(e);var n=t==null?-1:this.childNodes.indexOf(t);return n>-1?this.childNodes.splice(n,0,e):this.childNodes.push(e),e.parentNode=this,e},c.prototype.setAttributeNS=function(e,t,n){var r=null,i=t,a=t.indexOf(`:`);if(a>-1&&(r=t.substr(0,a),i=t.substr(a+1)),this.tagName===`INPUT`&&t===`type`)this.type=n;else{var o=this._attributes[e]||(this._attributes[e]={});o[i]={value:n,prefix:r}}},c.prototype.getAttributeNS=function(e,t){var n=this._attributes[e],r=n&&n[t]&&n[t].value;return this.tagName===`INPUT`&&t===`type`?this.type:typeof r==`string`?r:null},c.prototype.removeAttributeNS=function(e,t){var n=this._attributes[e];n&&delete n[t]},c.prototype.hasAttributeNS=function(e,t){var n=this._attributes[e];return!!n&&t in n},c.prototype.setAttribute=function(e,t){return this.setAttributeNS(null,e,t)},c.prototype.getAttribute=function(e){return this.getAttributeNS(null,e)},c.prototype.removeAttribute=function(e){return this.removeAttributeNS(null,e)},c.prototype.hasAttribute=function(e){return this.hasAttributeNS(null,e)},c.prototype.removeEventListener=a,c.prototype.addEventListener=i,c.prototype.dispatchEvent=r,c.prototype.focus=function(){},c.prototype.toString=function(){return o(this)},c.prototype.getElementsByClassName=function(e){var t=e.split(` `),r=[];return n(this,function(e){if(e.nodeType===1){var n=(e.className||``).split(` `);t.every(function(e){return n.indexOf(e)!==-1})&&r.push(e)}}),r},c.prototype.getElementsByTagName=function(e){e=e.toLowerCase();var t=[];return n(this.childNodes,function(n){n.nodeType===1&&(e===`*`||n.tagName.toLowerCase()===e)&&t.push(n)}),t},c.prototype.contains=function(e){return n(this,function(t){return e===t})||!1}}),pe=m(function(e,t){ne();var n=fe();t.exports=r;function r(e){if(!te(this,r))return new r;this.childNodes=[],this.parentNode=null,this.ownerDocument=e||null}r.prototype.type=`DocumentFragment`,r.prototype.nodeType=11,r.prototype.nodeName=`#document-fragment`,r.prototype.appendChild=n.prototype.appendChild,r.prototype.replaceChild=n.prototype.replaceChild,r.prototype.removeChild=n.prototype.removeChild,r.prototype.toString=function(){return this.childNodes.map(function(e){return String(e)}).join(``)}}),me=m(function(e,t){t.exports=n;function n(e){}n.prototype.initEvent=function(e,t,n){this.type=e,this.bubbles=t,this.cancelable=n},n.prototype.preventDefault=function(){}}),he=m(function(e,t){ne();var n=ae(),r=oe(),i=se(),a=fe(),o=pe(),s=me(),c=ce(),l=le(),u=ue();t.exports=d;function d(){if(!te(this,d))return new d;this.head=this.createElement(`head`),this.body=this.createElement(`body`),this.documentElement=this.createElement(`html`),this.documentElement.appendChild(this.head),this.documentElement.appendChild(this.body),this.childNodes=[this.documentElement],this.nodeType=9}var f=d.prototype;f.createTextNode=function(e){return new i(e,this)},f.createElementNS=function(e,t){var n=e===null?null:String(e);return new a(t,this,n)},f.createElement=function(e){return new a(e,this)},f.createDocumentFragment=function(){return new o(this)},f.createEvent=function(e){return new s(e)},f.createComment=function(e){return new r(e,this)},f.getElementById=function(e){return e=String(e),n(this.childNodes,function(t){if(String(t.id)===e)return t})||null},f.getElementsByClassName=a.prototype.getElementsByClassName,f.getElementsByTagName=a.prototype.getElementsByTagName,f.contains=a.prototype.contains,f.removeEventListener=u,f.addEventListener=l,f.dispatchEvent=c}),ge=m(function(e,t){t.exports=new(he())}),_e=m(function(e,t){var n=typeof global<`u`?global:typeof window<`u`?window:{},r=ge(),i;typeof document<`u`?i=document:(i=n[`__GLOBAL_DOCUMENT_CACHE@4`],i||=n[`__GLOBAL_DOCUMENT_CACHE@4`]=r),t.exports=i});function ve(e){if(Array.isArray(e))return e}function ye(e,t){var n=e==null?null:typeof Symbol<`u`&&e[Symbol.iterator]||e[`@@iterator`];if(n!=null){var r=[],i=!0,a=!1,o,s;try{for(n=n.call(e);!(i=(o=n.next()).done)&&(r.push(o.value),!(t&&r.length===t));i=!0);}catch(e){a=!0,s=e}finally{try{!i&&n.return!=null&&n.return()}finally{if(a)throw s}}return r}}function be(){throw TypeError(`Invalid attempt to destructure non-iterable instance.
In order to be iterable, non-array objects must have a [Symbol.iterator]() method.`)}function xe(e,t){(t==null||t>e.length)&&(t=e.length);for(var n=0,r=Array(t);n<t;n++)r[n]=e[n];return r}function Se(e,t){if(e){if(typeof e==`string`)return xe(e,t);var n=Object.prototype.toString.call(e).slice(8,-1);if(n===`Object`&&e.constructor&&(n=e.constructor.name),n===`Map`||n===`Set`)return Array.from(n);if(n===`Arguments`||/^(?:Ui|I)nt(?:8|16|32)(?:Clamped)?Array$/.test(n))return xe(e,t)}}function Ce(e,t){return ve(e)||ye(e,t)||Se(e,t)||be()}var g=typeof globalThis<`u`?globalThis:typeof window<`u`?window:typeof self<`u`?self:{},we={now:function(){var e=g.performance,t=e&&e.timing,n=t&&t.navigationStart,r=typeof n==`number`&&typeof e.now==`function`?n+e.now():Date.now();return Math.round(r)}},Te=function(){var e,t;if(typeof g.crypto?.getRandomValues==`function`){t=new Uint8Array(32),g.crypto.getRandomValues(t);for(var n=0;n<32;n++)t[n]=t[n]%16}else{t=[];for(var r=0;r<32;r++)t[r]=Math.random()*16|0}var i=0;e=`xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`.replace(/[xy]/g,function(e){var n=e===`x`?t[i]:t[i]&3|8;return i++,n.toString(16)});var a=we.now()?.toString(16).substring(3);return a?e.substring(0,28)+a:e},Ee=function(){return(`000000`+(Math.random()*36**6|0).toString(36)).slice(-6)},De=function(e){if(e&&e.nodeName!==void 0)return e.muxId||=Ee(),e.muxId;var t;try{t=document.querySelector(e)}catch{}return t&&!t.muxId&&(t.muxId=e),t?.muxId||e},Oe=function(e){var t;e&&e.nodeName!==void 0?(t=e,e=De(t)):t=document.querySelector(e);var n=t&&t.nodeName?t.nodeName.toLowerCase():``;return[t,e,n]};function ke(e){if(Array.isArray(e))return xe(e)}function Ae(e){if(typeof Symbol<`u`&&e[Symbol.iterator]!=null||e[`@@iterator`]!=null)return Array.from(e)}function je(){throw TypeError(`Invalid attempt to spread non-iterable instance.
In order to be iterable, non-array objects must have a [Symbol.iterator]() method.`)}function Me(e){return ke(e)||Ae(e)||Se(e)||je()}var Ne={TRACE:0,DEBUG:1,INFO:2,WARN:3,ERROR:4,SILENT:5},_=function(e){var t=arguments.length>1&&arguments[1]!==void 0?arguments[1]:3,n,r,i,a,o,s=[console,e],c=(n=console.trace).bind.apply(n,Me(s)),l=(r=console.info).bind.apply(r,Me(s)),u=(i=console.debug).bind.apply(i,Me(s)),d=(a=console.warn).bind.apply(a,Me(s)),f=(o=console.error).bind.apply(o,Me(s)),p=t;return{trace:function(){var e=[...arguments];if(!(p>Ne.TRACE))return c.apply(void 0,Me(e))},debug:function(){var e=[...arguments];if(!(p>Ne.DEBUG))return u.apply(void 0,Me(e))},info:function(){var e=[...arguments];if(!(p>Ne.INFO))return l.apply(void 0,Me(e))},warn:function(){var e=[...arguments];if(!(p>Ne.WARN))return d.apply(void 0,Me(e))},error:function(){var e=[...arguments];if(!(p>Ne.ERROR))return f.apply(void 0,Me(e))},get level(){return p},set level(e){e!==this.level&&(p=e??t)}}}(`[mux]`);function Pe(){return(g.doNotTrack||g.navigator&&g.navigator.doNotTrack)===`1`}function v(e){if(e===void 0)throw ReferenceError(`this hasn't been initialised - super() hasn't been called`);return e}ne();function Fe(e,t){if(!te(e,t))throw TypeError(`Cannot call a class as a function`)}function Ie(e,t){for(var n=0;n<t.length;n++){var r=t[n];r.enumerable=r.enumerable||!1,r.configurable=!0,`value`in r&&(r.writable=!0),Object.defineProperty(e,r.key,r)}}function Le(e,t,n){return t&&Ie(e.prototype,t),n&&Ie(e,n),e}function y(e,t,n){return t in e?Object.defineProperty(e,t,{value:n,enumerable:!0,configurable:!0,writable:!0}):e[t]=n,e}function Re(e){return Re=Object.setPrototypeOf?Object.getPrototypeOf:function(e){return e.__proto__||Object.getPrototypeOf(e)},Re(e)}function ze(e,t){for(;!Object.prototype.hasOwnProperty.call(e,t)&&(e=Re(e),e!==null););return e}function Be(e,t,n){return Be=typeof Reflect<`u`&&Reflect.get?Reflect.get:function(e,t,n){var r=ze(e,t);if(r){var i=Object.getOwnPropertyDescriptor(r,t);return i.get?i.get.call(n||e):i.value}},Be(e,t,n||e)}function Ve(e,t){return Ve=Object.setPrototypeOf||function(e,t){return e.__proto__=t,e},Ve(e,t)}function He(e,t){if(typeof t!=`function`&&t!==null)throw TypeError(`Super expression must either be null or a function`);e.prototype=Object.create(t&&t.prototype,{constructor:{value:e,writable:!0,configurable:!0}}),t&&Ve(e,t)}function Ue(e,t){if(e==null)return{};for(var n={},r=Object.keys(e),i,a=0;a<r.length;a++)i=r[a],!(t.indexOf(i)>=0)&&(n[i]=e[i]);return n}function We(e,t){if(e==null)return{};var n=Ue(e,t),r,i;if(Object.getOwnPropertySymbols){var a=Object.getOwnPropertySymbols(e);for(i=0;i<a.length;i++)r=a[i],!(t.indexOf(r)>=0)&&Object.prototype.propertyIsEnumerable.call(e,r)&&(n[r]=e[r])}return n}function Ge(){if(typeof Reflect>`u`||!Reflect.construct||Reflect.construct.sham)return!1;if(typeof Proxy==`function`)return!0;try{return Boolean.prototype.valueOf.call(Reflect.construct(Boolean,[],function(){})),!0}catch{return!1}}ie();function Ke(e,t){return t&&(re(t)===`object`||typeof t==`function`)?t:v(e)}function qe(e){var t=Ge();return function(){var n=Re(e),r;if(t){var i=Re(this).constructor;r=Reflect.construct(n,arguments,i)}else r=n.apply(this,arguments);return Ke(this,r)}}var Je=function(e){return Ye(e)[0]},Ye=function(e){if(typeof e!=`string`||e===``)return[`localhost`];var t=(e.match(/^(([^:\/?#]+):)?(\/\/([^\/?#]*))?([^?#]*)(\?([^#]*))?(#(.*))?/)||[])[4],n;return t&&(n=(t.match(/[^\.]+\.[^\.]+$/)||[])[0]),[t,n]},Xe={exists:function(){var e=g.performance;return(e&&e.timing)!==void 0},domContentLoadedEventEnd:function(){var e=g.performance,t=e&&e.timing;return t&&t.domContentLoadedEventEnd},navigationStart:function(){var e=g.performance,t=e&&e.timing;return t&&t.navigationStart}};function Ze(e,t,n){n=n===void 0?1:n,e[t]=e[t]||0,e[t]+=n}function Qe(e){for(var t=1;t<arguments.length;t++){var n=arguments[t]==null?{}:arguments[t],r=Object.keys(n);typeof Object.getOwnPropertySymbols==`function`&&(r=r.concat(Object.getOwnPropertySymbols(n).filter(function(e){return Object.getOwnPropertyDescriptor(n,e).enumerable}))),r.forEach(function(t){y(e,t,n[t])})}return e}function $e(e,t){var n=Object.keys(e);if(Object.getOwnPropertySymbols){var r=Object.getOwnPropertySymbols(e);t&&(r=r.filter(function(t){return Object.getOwnPropertyDescriptor(e,t).enumerable})),n.push.apply(n,r)}return n}function et(e,t){return t??={},Object.getOwnPropertyDescriptors?Object.defineProperties(e,Object.getOwnPropertyDescriptors(t)):$e(Object(t)).forEach(function(n){Object.defineProperty(e,n,Object.getOwnPropertyDescriptor(t,n))}),e}var tt=[`x-cdn`,`content-type`],nt=[`x-request-id`,`cf-ray`,`x-amz-cf-id`,`x-akamai-request-id`],rt=tt.concat(nt);function it(e){e||=``;var t={};return e.trim().split(/[\r\n]+/).forEach(function(e){if(e){var n=e.split(`: `),r=n.shift();r&&(rt.indexOf(r.toLowerCase())>=0||r.toLowerCase().indexOf(`x-litix-`)===0)&&(t[r]=n.join(`: `))}}),t}function at(e){if(e){var t=nt.find(function(t){return e[t]!==void 0});return t?e[t]:void 0}}var ot=function(e){var t={};for(var n in e){var r=e[n];if(r[`DATA-ID`].search(`io.litix.data.`)!==-1){var i=r[`DATA-ID`].replace(`io.litix.data.`,``);t[i]=r.VALUE}}return t},st=function(e){if(!e)return{};var t=Xe.navigationStart(),n=e.loading,r=n?n.start:e.trequest,i=n?n.first:e.tfirst,a=n?n.end:e.tload;return{bytesLoaded:e.total,requestStart:Math.round(t+r),responseStart:Math.round(t+i),responseEnd:Math.round(t+a)}},ct=function(e){if(e&&typeof e.getAllResponseHeaders==`function`)return it(e.getAllResponseHeaders())},lt=function(e,t,n){arguments.length>3&&arguments[3]!==void 0&&arguments[3];var r=arguments.length>4?arguments[4]:void 0,i=e.log,a=e.utils.secondsToMs,o=function(e){var t=parseInt(r.version),n;return t===1&&e.programDateTime!==null&&(n=e.programDateTime),t===0&&e.pdt!==null&&(n=e.pdt),n};if(!Xe.exists())i.warn(`performance timing not supported. Not tracking HLS.js.`);else{var s=function(n,r){return e.emit(t,n,r)},c=function(e,t){var n=t.levels,r=t.audioTracks,i=t.url,a=t.stats,o=t.networkDetails,c=t.sessionData,l={},u={};n.forEach(function(e,t){l[t]={width:e.width,height:e.height,bitrate:e.bitrate,attrs:e.attrs}}),r.forEach(function(e,t){u[t]={name:e.name,language:e.lang,bitrate:e.bitrate}});var d=st(a),f=d.bytesLoaded,p=d.requestStart,m=d.responseStart,h=d.responseEnd;s(`requestcompleted`,et(Qe({},ot(c)),{request_event_type:e,request_bytes_loaded:f,request_start:p,request_response_start:m,request_response_end:h,request_type:`manifest`,request_hostname:Je(i),request_response_headers:ct(o),request_rendition_lists:{media:l,audio:u,video:{}}}))};n.on(r.Events.MANIFEST_LOADED,c);var l=function(e,t){var n=t.details,r=t.level,i=t.networkDetails,c=t.stats,l=st(c),u=l.bytesLoaded,d=l.requestStart,f=l.responseStart,p=l.responseEnd,m=n.fragments[n.fragments.length-1],h=o(m)+a(m.duration);s(`requestcompleted`,{request_event_type:e,request_bytes_loaded:u,request_start:d,request_response_start:f,request_response_end:p,request_current_level:r,request_type:`manifest`,request_hostname:Je(n.url),request_response_headers:ct(i),video_holdback:n.holdBack&&a(n.holdBack),video_part_holdback:n.partHoldBack&&a(n.partHoldBack),video_part_target_duration:n.partTarget&&a(n.partTarget),video_target_duration:n.targetduration&&a(n.targetduration),video_source_is_live:n.live,player_manifest_newest_program_time:isNaN(h)?void 0:h})};n.on(r.Events.LEVEL_LOADED,l);var u=function(e,t){var n=t.details,r=t.networkDetails,i=t.stats,a=st(i),o=a.bytesLoaded,c=a.requestStart,l=a.responseStart,u=a.responseEnd;s(`requestcompleted`,{request_event_type:e,request_bytes_loaded:o,request_start:c,request_response_start:l,request_response_end:u,request_type:`manifest`,request_hostname:Je(n.url),request_response_headers:ct(r)})};n.on(r.Events.AUDIO_TRACK_LOADED,u);var d=function(e,t){var r=t.stats,i=t.networkDetails,a=t.frag;r||=a.stats;var o=st(r),c=o.bytesLoaded,l=o.requestStart,u=o.responseStart,d=o.responseEnd,f=i?ct(i):void 0,p={request_event_type:e,request_bytes_loaded:c,request_start:l,request_response_start:u,request_response_end:d,request_hostname:i?Je(i.responseURL):void 0,request_id:f?at(f):void 0,request_response_headers:f,request_media_duration:a.duration,request_url:i?.responseURL};a.type===`main`?(p.request_type=`media`,p.request_current_level=a.level,p.request_video_width=(n.levels[a.level]||{}).width,p.request_video_height=(n.levels[a.level]||{}).height,p.request_labeled_bitrate=(n.levels[a.level]||{}).bitrate):p.request_type=a.type,s(`requestcompleted`,p)};n.on(r.Events.FRAG_LOADED,d);var f=function(e,t){var n=t.frag,r=n.start;s(`fragmentchange`,{currentFragmentPDT:o(n),currentFragmentStart:a(r)})};n.on(r.Events.FRAG_CHANGED,f);var p=function(e,t){var n=t.type,i=t.details,a=t.response,o=t.fatal,c=t.frag,l=t.networkDetails,u=c?.url||t.url||``,d=l?ct(l):void 0;(i===r.ErrorDetails.MANIFEST_LOAD_ERROR||i===r.ErrorDetails.MANIFEST_LOAD_TIMEOUT||i===r.ErrorDetails.FRAG_LOAD_ERROR||i===r.ErrorDetails.FRAG_LOAD_TIMEOUT||i===r.ErrorDetails.LEVEL_LOAD_ERROR||i===r.ErrorDetails.LEVEL_LOAD_TIMEOUT||i===r.ErrorDetails.AUDIO_TRACK_LOAD_ERROR||i===r.ErrorDetails.AUDIO_TRACK_LOAD_TIMEOUT||i===r.ErrorDetails.SUBTITLE_LOAD_ERROR||i===r.ErrorDetails.SUBTITLE_LOAD_TIMEOUT||i===r.ErrorDetails.KEY_LOAD_ERROR||i===r.ErrorDetails.KEY_LOAD_TIMEOUT)&&s(`requestfailed`,{request_error:i,request_url:u,request_hostname:Je(u),request_id:d?at(d):void 0,request_type:i===r.ErrorDetails.FRAG_LOAD_ERROR||i===r.ErrorDetails.FRAG_LOAD_TIMEOUT?`media`:i===r.ErrorDetails.AUDIO_TRACK_LOAD_ERROR||i===r.ErrorDetails.AUDIO_TRACK_LOAD_TIMEOUT?`audio`:i===r.ErrorDetails.SUBTITLE_LOAD_ERROR||i===r.ErrorDetails.SUBTITLE_LOAD_TIMEOUT?`subtitle`:i===r.ErrorDetails.KEY_LOAD_ERROR||i===r.ErrorDetails.KEY_LOAD_TIMEOUT?`encryption`:`manifest`,request_error_code:a?.code,request_error_text:a?.text}),o&&s(`error`,{player_error_code:n,player_error_message:i,player_error_context:`${u?`url: ${u}
`:``}${a&&(a.code||a.text)?`response: ${a.code}, ${a.text}
`:``}${t.reason?`failure reason: ${t.reason}
`:``}${t.level?`level: ${t.level}
`:``}${t.parent?`parent stream controller: ${t.parent}
`:``}${t.buffer?`buffer length: ${t.buffer}
`:``}${t.error?`error: ${t.error}
`:``}${t.event?`event: ${t.event}
`:``}${t.err?`error message: ${t.err?.message}
`:``}`})};n.on(r.Events.ERROR,p);var m=function(e,t){var n=t.frag,r=n&&n._url||``;s(`requestcanceled`,{request_event_type:e,request_url:r,request_type:`media`,request_hostname:Je(r)})};n.on(r.Events.FRAG_LOAD_EMERGENCY_ABORTED,m);var h=function(e,t){var r=t.level,a=n.levels[r];if(a&&a.attrs&&a.attrs.BANDWIDTH){var o=a.attrs.BANDWIDTH,c,l=parseFloat(a.attrs[`FRAME-RATE`]);isNaN(l)||(c=l),o?s(`renditionchange`,{video_source_fps:c,video_source_bitrate:o,video_source_width:a.width,video_source_height:a.height,video_source_rendition_name:a.name,video_source_codec:a?.videoCodec}):i.warn(`missing BANDWIDTH from HLS manifest parsed by HLS.js`)}};n.on(r.Events.LEVEL_SWITCHED,h),n._stopMuxMonitor=function(){n.off(r.Events.MANIFEST_LOADED,c),n.off(r.Events.LEVEL_LOADED,l),n.off(r.Events.AUDIO_TRACK_LOADED,u),n.off(r.Events.FRAG_LOADED,d),n.off(r.Events.FRAG_CHANGED,f),n.off(r.Events.ERROR,p),n.off(r.Events.FRAG_LOAD_EMERGENCY_ABORTED,m),n.off(r.Events.LEVEL_SWITCHED,h),n.off(r.Events.DESTROYING,n._stopMuxMonitor),delete n._stopMuxMonitor},n.on(r.Events.DESTROYING,n._stopMuxMonitor)}},ut=function(e){e&&typeof e._stopMuxMonitor==`function`&&e._stopMuxMonitor()},dt=function(e,t){if(!e||!e.requestEndDate)return{};var n=Je(e.url),r=e.url,i=e.bytesLoaded,a=new Date(e.requestStartDate).getTime(),o=new Date(e.firstByteDate).getTime(),s=new Date(e.requestEndDate).getTime(),c=isNaN(e.duration)?0:e.duration,l=typeof t.getMetricsFor==`function`?t.getMetricsFor(e.mediaType).HttpList:t.getDashMetrics().getHttpRequests(e.mediaType),u;l.length>0&&(u=it(l[l.length-1]._responseHeaders||``));var d=u?at(u):void 0;return{requestStart:a,requestResponseStart:o,requestResponseEnd:s,requestBytesLoaded:i,requestResponseHeaders:u,requestMediaDuration:c,requestHostname:n,requestUrl:r,requestId:d}},ft=function(e,t){if(typeof t.getCurrentRepresentationForType==`function`){var n=t.getCurrentRepresentationForType(e);return n?{currentLevel:n.absoluteIndex,renditionWidth:n.width||null,renditionHeight:n.height||null,renditionBitrate:n.bandwidth}:{}}var r=t.getQualityFor(e),i=t.getCurrentTrackFor(e).bitrateList;return i?{currentLevel:r,renditionWidth:i[r].width||null,renditionHeight:i[r].height||null,renditionBitrate:i[r].bandwidth}:{}},pt=function(e){return e.match(/.*codecs\*?="(.*)"/)?.[1]},mt=function(e){try{var t,n;return(n=e.getVersion)==null||(t=n.call(e))==null?void 0:t.split(`.`).map(function(e){return parseInt(e)})[0]}catch{return!1}},ht=function(e,t,n){arguments.length>3&&arguments[3]!==void 0&&arguments[3];var r=e.log;if(!n||!n.on)r.warn(`Invalid dash.js player reference. Monitoring blocked.`);else{var i=mt(n),a=function(n,r){return e.emit(t,n,r)},o=function(e){var t=e.type,n=(e.data||{}).url;a(`requestcompleted`,{request_event_type:t,request_start:0,request_response_start:0,request_response_end:0,request_bytes_loaded:-1,request_type:`manifest`,request_hostname:Je(n),request_url:n})};n.on(`manifestLoaded`,o);var s={},c=function(e){if(typeof e.getRequests!=`function`)return null;var t=e.getRequests({state:`executed`});return t.length===0?null:t[t.length-1]},l=function(e){var t=e.type,n=e.fragmentModel,r=e.chunk;u({type:t,request:c(n),chunk:r})},u=function(e){var t=e.type,r=e.chunk,i=e.request,o=(r||{}).mediaInfo||{},c=o.type,l=o.bitrateList;l||=[];var u={};l.forEach(function(e,t){u[t]={},u[t].width=e.width,u[t].height=e.height,u[t].bitrate=e.bandwidth,u[t].attrs={}}),c===`video`?s.video=u:c===`audio`?s.audio=u:s.media=u;var d=dt(i,n),f=d.requestStart,p=d.requestResponseStart,m=d.requestResponseEnd,h=d.requestResponseHeaders,ee=d.requestMediaDuration,te=d.requestHostname,ne=d.requestUrl,re=d.requestId;a(`requestcompleted`,{request_event_type:t,request_start:f,request_response_start:p,request_response_end:m,request_bytes_loaded:-1,request_type:c+`_init`,request_response_headers:h,request_hostname:te,request_id:re,request_url:ne,request_media_duration:ee,request_rendition_lists:s})};i>=4?n.on(`initFragmentLoaded`,u):n.on(`initFragmentLoaded`,l);var d=function(e){var t=e.type,n=e.fragmentModel,r=e.chunk;f({type:t,request:c(n),chunk:r})},f=function(e){var t=e.type,r=e.chunk,i=e.request,o=r||{},s=o.mediaInfo,c=o.start,l=(s||{}).type,u=dt(i,n),d=u.requestStart,f=u.requestResponseStart,p=u.requestResponseEnd,m=u.requestBytesLoaded,h=u.requestResponseHeaders,ee=u.requestMediaDuration,te=u.requestHostname,ne=u.requestUrl,re=u.requestId,ie=ft(l,n),ae=ie.currentLevel,oe=ie.renditionWidth,se=ie.renditionHeight,ce=ie.renditionBitrate;a(`requestcompleted`,{request_event_type:t,request_start:d,request_response_start:f,request_response_end:p,request_bytes_loaded:m,request_type:l,request_response_headers:h,request_hostname:te,request_id:re,request_url:ne,request_media_start_time:c,request_media_duration:ee,request_current_level:ae,request_labeled_bitrate:ce,request_video_width:oe,request_video_height:se})};i>=4?n.on(`mediaFragmentLoaded`,f):n.on(`mediaFragmentLoaded`,d);var p={video:void 0,audio:void 0,totalBitrate:void 0},m=function(){if(p.video&&typeof p.video.bitrate==`number`){if(!(p.video.width&&p.video.height)){r.warn(`have bitrate info for video but missing width/height`);return}var e=p.video.bitrate;if(p.audio&&typeof p.audio.bitrate==`number`&&(e+=p.audio.bitrate),e!==p.totalBitrate)return p.totalBitrate=e,{video_source_bitrate:e,video_source_height:p.video.height,video_source_width:p.video.width,video_source_codec:pt(p.video.codec)}}},h=function(e,t,i){var o=e.mediaType;if(o===`audio`||o===`video`){var s;if(typeof n.getRepresentationsByType==`function`){if(e.newRepresentation)s={bitrate:e.newRepresentation.bandwidth,width:e.newRepresentation.width,height:e.newRepresentation.height,qualityIndex:e.newRepresentation.absoluteIndex};else{var c=n.getRepresentationsByType(o);if(c&&typeof e.newQuality==`number`){var l=c.find(function(t){return t.absoluteIndex===e.newQuality||t.index===e.newQuality});l&&(s={bitrate:l.bandwidth,width:l.width,height:l.height,qualityIndex:e.newQuality})}}}else{if(typeof e.newQuality!=`number`){r.warn(`missing evt.newQuality in qualityChangeRendered event`,e);return}s=n.getBitrateInfoListFor(o).find(function(t){return t.qualityIndex===e.newQuality})}if(!(s&&typeof s.bitrate==`number`)){r.warn(`missing bitrate info for ${o}`);return}p[o]=et(Qe({},s),{codec:n.getCurrentTrackFor(o).codec});var u=m();u&&a(`renditionchange`,u)}};n.on(`qualityChangeRendered`,h);var ee=function(e){var t=e.request,n=e.mediaType;t||={},a(`requestcanceled`,{request_event_type:t.type+`_`+t.action,request_url:t.url,request_type:n,request_hostname:Je(t.url)})};n.on(`fragmentLoadingAbandoned`,ee);var te=function(e){var t=e.error,n,r,i=(t==null||(n=t.data)==null?void 0:n.request)||{},o=(t==null||(r=t.data)==null?void 0:r.response)||{};t?.code===27&&a(`requestfailed`,{request_error:i.type+`_`+i.action,request_url:i.url,request_hostname:Je(i.url),request_type:i.mediaType,request_error_code:o.status,request_error_text:o.statusText});var s=`${i!=null&&i.url?`url: ${i.url}
`:``}${o!=null&&o.status||o!=null&&o.statusText?`response: ${o?.status}, ${o?.statusText}
`:``}`;a(`error`,{player_error_code:t?.code,player_error_message:t?.message,player_error_context:s})};n.on(`error`,te),n._stopMuxMonitor=function(){n.off(`manifestLoaded`,o),n.off(`initFragmentLoaded`,u),n.off(`mediaFragmentLoaded`,f),n.off(`qualityChangeRendered`,h),n.off(`error`,te),n.off(`fragmentLoadingAbandoned`,ee),delete n._stopMuxMonitor}}},gt=function(e){e&&typeof e._stopMuxMonitor==`function`&&e._stopMuxMonitor()},_t=0,vt=function(){function e(){Fe(this,e),y(this,`_listeners`,void 0)}return Le(e,[{key:`on`,value:function(e,t,n){return t._eventEmitterGuid=t._eventEmitterGuid||++_t,this._listeners=this._listeners||{},this._listeners[e]=this._listeners[e]||[],n&&(t=t.bind(n)),this._listeners[e].push(t),t}},{key:`off`,value:function(e,t){var n=this._listeners&&this._listeners[e];n&&n.forEach(function(e,r){e._eventEmitterGuid===t._eventEmitterGuid&&n.splice(r,1)})}},{key:`one`,value:function(e,t,n){var r=this;t._eventEmitterGuid=t._eventEmitterGuid||++_t;var i=function(){r.off(e,i),t.apply(n||this,arguments)};i._eventEmitterGuid=t._eventEmitterGuid,this.on(e,i)}},{key:`emit`,value:function(e,t){var n=this;if(this._listeners){t||={};var r=this._listeners[`before`+e]||[],i=this._listeners[`before*`]||[],a=this._listeners[e]||[],o=this._listeners[`after`+e]||[],s=function(t,r){t=t.slice(),t.forEach(function(t){t.call(n,{type:e},r)})};s(r,t),s(i,t),s(a,t),s(o,t)}}}]),e}(),yt=function(){function e(t){var n=this;Fe(this,e),y(this,`_playbackHeartbeatInterval`,void 0),y(this,`_playheadShouldBeProgressing`,void 0),y(this,`pm`,void 0),this.pm=t,this._playbackHeartbeatInterval=null,this._playheadShouldBeProgressing=!1,t.on(`playing`,function(){n._playheadShouldBeProgressing=!0}),t.on(`play`,this._startPlaybackHeartbeatInterval.bind(this)),t.on(`playing`,this._startPlaybackHeartbeatInterval.bind(this)),t.on(`adbreakstart`,this._startPlaybackHeartbeatInterval.bind(this)),t.on(`adplay`,this._startPlaybackHeartbeatInterval.bind(this)),t.on(`adplaying`,this._startPlaybackHeartbeatInterval.bind(this)),t.on(`devicewake`,this._startPlaybackHeartbeatInterval.bind(this)),t.on(`viewstart`,this._startPlaybackHeartbeatInterval.bind(this)),t.on(`rebufferstart`,this._startPlaybackHeartbeatInterval.bind(this)),t.on(`pause`,this._stopPlaybackHeartbeatInterval.bind(this)),t.on(`ended`,this._stopPlaybackHeartbeatInterval.bind(this)),t.on(`viewend`,this._stopPlaybackHeartbeatInterval.bind(this)),t.on(`error`,this._stopPlaybackHeartbeatInterval.bind(this)),t.on(`aderror`,this._stopPlaybackHeartbeatInterval.bind(this)),t.on(`adpause`,this._stopPlaybackHeartbeatInterval.bind(this)),t.on(`adended`,this._stopPlaybackHeartbeatInterval.bind(this)),t.on(`adbreakend`,this._stopPlaybackHeartbeatInterval.bind(this)),t.on(`seeked`,function(){t.data.player_is_paused?n._stopPlaybackHeartbeatInterval():n._startPlaybackHeartbeatInterval()}),t.on(`timeupdate`,function(){n._playbackHeartbeatInterval!==null&&t.emit(`playbackheartbeat`)}),t.on(`devicesleep`,function(e,r){n._playbackHeartbeatInterval!==null&&(g.clearInterval(n._playbackHeartbeatInterval),t.emit(`playbackheartbeatend`,{viewer_time:r.viewer_time}),n._playbackHeartbeatInterval=null)})}return Le(e,[{key:`_startPlaybackHeartbeatInterval`,value:function(){var e=this;this._playbackHeartbeatInterval===null&&(this.pm.emit(`playbackheartbeat`),this._playbackHeartbeatInterval=g.setInterval(function(){e.pm.emit(`playbackheartbeat`)},this.pm.playbackHeartbeatTime))}},{key:`_stopPlaybackHeartbeatInterval`,value:function(){this._playheadShouldBeProgressing=!1,this._playbackHeartbeatInterval!==null&&(g.clearInterval(this._playbackHeartbeatInterval),this.pm.emit(`playbackheartbeatend`),this._playbackHeartbeatInterval=null)}}]),e}(),bt=function e(t){var n=this;Fe(this,e),y(this,`viewErrored`,void 0),t.on(`viewinit`,function(){n.viewErrored=!1}),t.on(`error`,function(e,r){try{var i=t.errorTranslator({player_error_code:r.player_error_code,player_error_message:r.player_error_message,player_error_context:r.player_error_context,player_error_severity:r.player_error_severity,player_error_business_exception:r.player_error_business_exception});i&&(t.data.player_error_code=i.player_error_code||r.player_error_code,t.data.player_error_message=i.player_error_message||r.player_error_message,t.data.player_error_context=i.player_error_context||r.player_error_context,t.data.player_error_severity=i.player_error_severity||r.player_error_severity,t.data.player_error_business_exception=i.player_error_business_exception||r.player_error_business_exception,n.viewErrored=!0)}catch(e){t.mux.log.warn(`Exception in error translator callback.`,e),n.viewErrored=!0}}),t.on(`aftererror`,function(){var e,n,r,i,a;(e=t.data)==null||delete e.player_error_code,(n=t.data)==null||delete n.player_error_message,(r=t.data)==null||delete r.player_error_context,(i=t.data)==null||delete i.player_error_severity,(a=t.data)==null||delete a.player_error_business_exception})},xt=function(){function e(t){Fe(this,e),y(this,`_watchTimeTrackerLastCheckedTime`,void 0),y(this,`pm`,void 0),this.pm=t,this._watchTimeTrackerLastCheckedTime=null,t.on(`playbackheartbeat`,this._updateWatchTime.bind(this)),t.on(`playbackheartbeatend`,this._clearWatchTimeState.bind(this))}return Le(e,[{key:`_updateWatchTime`,value:function(e,t){var n=t.viewer_time;this._watchTimeTrackerLastCheckedTime===null&&(this._watchTimeTrackerLastCheckedTime=n),Ze(this.pm.data,`view_watch_time`,n-this._watchTimeTrackerLastCheckedTime),this._watchTimeTrackerLastCheckedTime=n}},{key:`_clearWatchTimeState`,value:function(e,t){this._updateWatchTime(e,t),this._watchTimeTrackerLastCheckedTime=null}}]),e}(),St=function(){function e(t){var n=this;Fe(this,e),y(this,`_playbackTimeTrackerLastPlayheadPosition`,void 0),y(this,`_lastTime`,void 0),y(this,`_isAdPlaying`,void 0),y(this,`_callbackUpdatePlaybackTime`,void 0),y(this,`pm`,void 0),this.pm=t,this._playbackTimeTrackerLastPlayheadPosition=-1,this._lastTime=we.now(),this._isAdPlaying=!1,this._callbackUpdatePlaybackTime=null,t.on(`viewinit`,function(){n.pm.data.view_playing_time_ms_cumulative=0});var r=this._startPlaybackTimeTracking.bind(this);t.on(`playing`,r),t.on(`adplaying`,r);var i=function(){n.pm.data.player_is_paused||r()};t.on(`seeked`,i),t.on(`rebufferend`,i);var a=this._stopPlaybackTimeTracking.bind(this);t.on(`playbackheartbeatend`,a),t.on(`seeking`,a),t.on(`rebufferstart`,a),t.on(`adplaying`,function(){n._isAdPlaying=!0}),t.on(`adended`,function(){n._isAdPlaying=!1}),t.on(`adpause`,function(){n._isAdPlaying=!1}),t.on(`adbreakstart`,function(){n._isAdPlaying=!1}),t.on(`adbreakend`,function(){n._isAdPlaying=!1}),t.on(`adplay`,function(){n._isAdPlaying=!1}),t.on(`viewinit`,function(){n._playbackTimeTrackerLastPlayheadPosition=-1,n._lastTime=we.now(),n._isAdPlaying=!1,n._callbackUpdatePlaybackTime=null})}return Le(e,[{key:`_startPlaybackTimeTracking`,value:function(){this._callbackUpdatePlaybackTime===null&&(this._callbackUpdatePlaybackTime=this._updatePlaybackTime.bind(this),this._playbackTimeTrackerLastPlayheadPosition=this.pm.data.player_playhead_time,this._lastTime=we.now(),this.pm.on(`playbackheartbeat`,this._callbackUpdatePlaybackTime))}},{key:`_stopPlaybackTimeTracking`,value:function(){this._callbackUpdatePlaybackTime&&(this._updatePlaybackTime(),this.pm.off(`playbackheartbeat`,this._callbackUpdatePlaybackTime),this._callbackUpdatePlaybackTime=null,this._playbackTimeTrackerLastPlayheadPosition=-1)}},{key:`_updatePlaybackTime`,value:function(){var e=this.pm.data.player_playhead_time||0,t=we.now(),n=t-this._lastTime,r=-1;this._playbackTimeTrackerLastPlayheadPosition>=0&&e>this._playbackTimeTrackerLastPlayheadPosition?r=e-this._playbackTimeTrackerLastPlayheadPosition:this._isAdPlaying&&(r=n),r>0&&r<=1e3&&Ze(this.pm.data,`view_content_playback_time`,r),this._callbackUpdatePlaybackTime!==null&&n>0&&n<=1e3&&(this._isAdPlaying&&Ze(this.pm.data,`ad_playing_time_ms_cumulative`,n),Ze(this.pm.data,`view_playing_time_ms_cumulative`,n)),this._playbackTimeTrackerLastPlayheadPosition=e,this._lastTime=t}}]),e}(),Ct=function(){function e(t){Fe(this,e),y(this,`pm`,void 0),this.pm=t;var n=this._updatePlayheadTime.bind(this);t.on(`playbackheartbeat`,n),t.on(`playbackheartbeatend`,n),t.on(`timeupdate`,n),t.on(`destroy`,function(){t.off(`timeupdate`,n)})}return Le(e,[{key:`_updateMaxPlayheadPosition`,value:function(){this.pm.data.view_max_playhead_position=this.pm.data.view_max_playhead_position===void 0?this.pm.data.player_playhead_time:Math.max(this.pm.data.view_max_playhead_position,this.pm.data.player_playhead_time)}},{key:`_updatePlayheadTime`,value:function(e,t){var n=this,r=function(){n.pm.currentFragmentPDT&&n.pm.currentFragmentStart&&(n.pm.data.player_program_time=n.pm.currentFragmentPDT+n.pm.data.player_playhead_time-n.pm.currentFragmentStart)};if(t&&t.player_playhead_time)this.pm.data.player_playhead_time=t.player_playhead_time,r(),this._updateMaxPlayheadPosition();else if(this.pm.getPlayheadTime){var i=this.pm.getPlayheadTime();i!==void 0&&(this.pm.data.player_playhead_time=i,r(),this._updateMaxPlayheadPosition())}}}]),e}(),wt=3e5,Tt=function e(t){if(Fe(this,e),!t.disableRebufferTracking){var n,r=function(e,t){i(t),n=void 0},i=function(e){if(n){var r=e.viewer_time-n;Ze(t.data,`view_rebuffer_duration`,r),n=e.viewer_time,t.data.view_rebuffer_duration>wt&&(t.emit(`viewend`),t.send(`viewend`),t.mux.log.warn(`Ending view after rebuffering for longer than ${wt}ms, future events will be ignored unless a programchange or videochange occurs.`))}t.data.view_watch_time>=0&&t.data.view_rebuffer_count>0&&(t.data.view_rebuffer_frequency=t.data.view_rebuffer_count/t.data.view_watch_time,t.data.view_rebuffer_percentage=t.data.view_rebuffer_duration/t.data.view_watch_time)};t.on(`playbackheartbeat`,function(e,t){return i(t)}),t.on(`rebufferstart`,function(e,i){n||(Ze(t.data,`view_rebuffer_count`,1),n=i.viewer_time,t.one(`rebufferend`,r))}),t.on(`viewinit`,function(){n=void 0,t.off(`rebufferend`,r)})}},Et=function(){function e(t){var n=this;Fe(this,e),y(this,`_lastCheckedTime`,void 0),y(this,`_lastPlayheadTime`,void 0),y(this,`_lastPlayheadTimeUpdatedTime`,void 0),y(this,`_rebuffering`,void 0),y(this,`pm`,void 0),this.pm=t,!(t.disableRebufferTracking||t.disablePlayheadRebufferTracking)&&(this._lastCheckedTime=null,this._lastPlayheadTime=null,this._lastPlayheadTimeUpdatedTime=null,t.on(`playbackheartbeat`,this._checkIfRebuffering.bind(this)),t.on(`playbackheartbeatend`,this._cleanupRebufferTracker.bind(this)),t.on(`seeking`,function(){n._cleanupRebufferTracker(null,{viewer_time:we.now()})}))}return Le(e,[{key:`_checkIfRebuffering`,value:function(e,t){if(this.pm.seekingTracker.isSeeking||this.pm.adTracker.isAdBreak||!this.pm.playbackHeartbeat._playheadShouldBeProgressing)this._cleanupRebufferTracker(e,t);else if(this._lastCheckedTime===null)this._prepareRebufferTrackerState(t.viewer_time);else if(this._lastPlayheadTime!==this.pm.data.player_playhead_time)this._cleanupRebufferTracker(e,t,!0);else{var n=t.viewer_time-this._lastPlayheadTimeUpdatedTime;typeof this.pm.sustainedRebufferThreshold==`number`&&n>=this.pm.sustainedRebufferThreshold&&(this._rebuffering||(this._rebuffering=!0,this.pm.emit(`rebufferstart`,{viewer_time:this._lastPlayheadTimeUpdatedTime}))),this._lastCheckedTime=t.viewer_time}}},{key:`_clearRebufferTrackerState`,value:function(){this._lastCheckedTime=null,this._lastPlayheadTime=null,this._lastPlayheadTimeUpdatedTime=null}},{key:`_prepareRebufferTrackerState`,value:function(e){this._lastCheckedTime=e,this._lastPlayheadTime=this.pm.data.player_playhead_time,this._lastPlayheadTimeUpdatedTime=e}},{key:`_cleanupRebufferTracker`,value:function(e,t){var n=arguments.length>2&&arguments[2]!==void 0&&arguments[2];if(this._rebuffering)this._rebuffering=!1,this.pm.emit(`rebufferend`,{viewer_time:t.viewer_time});else{if(this._lastCheckedTime===null)return;var r=this.pm.data.player_playhead_time-this._lastPlayheadTime,i=t.viewer_time-this._lastPlayheadTimeUpdatedTime;typeof this.pm.minimumRebufferDuration==`number`&&r>0&&i-r>this.pm.minimumRebufferDuration&&(this._lastCheckedTime=null,this.pm.emit(`rebufferstart`,{viewer_time:this._lastPlayheadTimeUpdatedTime}),this.pm.emit(`rebufferend`,{viewer_time:this._lastPlayheadTimeUpdatedTime+i-r}))}n?this._prepareRebufferTrackerState(t.viewer_time):this._clearRebufferTrackerState()}}]),e}(),Dt=function(){function e(t){var n=this;Fe(this,e),y(this,`pm`,void 0),this.pm=t,t.on(`viewinit`,function(){var e=t.data,r=e.view_id;if(!e.view_program_changed){var i=function(e,i){var a=i.viewer_time;(e.type===`playing`&&t.data.view_time_to_first_frame===void 0||e.type===`adplaying`&&(t.data.view_time_to_first_frame===void 0||n._inPrerollPosition()))&&n.calculateTimeToFirstFrame(a||we.now(),r)};t.one(`playing`,i),t.one(`adplaying`,i),t.one(`viewend`,function(){t.off(`playing`,i),t.off(`adplaying`,i)})}})}return Le(e,[{key:`_inPrerollPosition`,value:function(){return this.pm.data.view_content_playback_time===void 0||this.pm.data.view_content_playback_time<=1e3}},{key:`calculateTimeToFirstFrame`,value:function(e,t){t===this.pm.data.view_id&&(this.pm.watchTimeTracker._updateWatchTime(null,{viewer_time:e}),this.pm.data.view_time_to_first_frame=this.pm.data.view_watch_time,(this.pm.data.player_autoplay_on||this.pm.data.video_is_autoplay)&&this.pm.pageLoadInitTime&&(this.pm.data.view_aggregate_startup_time=this.pm.data.view_start+this.pm.data.view_watch_time-this.pm.pageLoadInitTime))}}]),e}(),Ot=function e(t){var n=this;Fe(this,e),y(this,`_lastPlayerHeight`,void 0),y(this,`_lastPlayerWidth`,void 0),y(this,`_lastPlayheadPosition`,void 0),y(this,`_lastSourceHeight`,void 0),y(this,`_lastSourceWidth`,void 0),t.on(`viewinit`,function(){n._lastPlayheadPosition=-1}),[`pause`,`rebufferstart`,`seeking`,`error`,`adbreakstart`,`hb`,`renditionchange`,`orientationchange`,`viewend`,`playbackmodechange`].forEach(function(e){t.on(e,function(){if(n._lastPlayheadPosition>=0&&t.data.player_playhead_time>=0&&n._lastPlayerWidth>=0&&n._lastSourceWidth>0&&n._lastPlayerHeight>=0&&n._lastSourceHeight>0){var e=t.data.player_playhead_time-n._lastPlayheadPosition;if(e<0){n._lastPlayheadPosition=-1;return}var r=Math.min(n._lastPlayerWidth/n._lastSourceWidth,n._lastPlayerHeight/n._lastSourceHeight),i=Math.max(0,r-1),a=Math.max(0,1-r);t.data.view_max_upscale_percentage=Math.max(t.data.view_max_upscale_percentage||0,i),t.data.view_max_downscale_percentage=Math.max(t.data.view_max_downscale_percentage||0,a),Ze(t.data,`view_total_content_playback_time`,e),Ze(t.data,`view_total_upscaling`,i*e),Ze(t.data,`view_total_downscaling`,a*e)}n._lastPlayheadPosition=-1})}),[`playing`,`hb`,`renditionchange`,`orientationchange`,`playbackmodechange`].forEach(function(e){t.on(e,function(){n._lastPlayheadPosition=t.data.player_playhead_time,n._lastPlayerWidth=t.data.player_width,n._lastPlayerHeight=t.data.player_height,n._lastSourceWidth=t.data.video_source_width,n._lastSourceHeight=t.data.video_source_height})})},kt=2e3,At=function e(t){var n=this;Fe(this,e),y(this,`isSeeking`,void 0),this.isSeeking=!1;var r=-1,i=function(){var e=we.now(),i=(t.data.viewer_time||e)-(r||e);Ze(t.data,`view_seek_duration`,i),t.data.view_max_seek_time=Math.max(t.data.view_max_seek_time||0,i),n.isSeeking=!1,r=-1};t.on(`seeking`,function(e,a){Object.assign(t.data,a),n.isSeeking&&a.viewer_time-r<=kt?r=a.viewer_time:(n.isSeeking&&i(),n.isSeeking=!0,r=a.viewer_time,Ze(t.data,`view_seek_count`,1),t.send(`seeking`))}),t.on(`seeked`,function(){i()}),t.on(`viewend`,function(){n.isSeeking&&(i(),t.send(`seeked`)),n.isSeeking=!1,r=-1})},jt=function(e,t){e.push(t),e.sort(function(e,t){return e.viewer_time-t.viewer_time})},Mt=[`adbreakstart`,`adrequest`,`adresponse`,`adplay`,`adplaying`,`adpause`,`adended`,`adbreakend`,`aderror`,`adclicked`,`adskipped`],Nt=function(){function e(t){var n=this;Fe(this,e),y(this,`_adHasPlayed`,void 0),y(this,`_adRequests`,void 0),y(this,`_adResponses`,void 0),y(this,`_currentAdRequestNumber`,void 0),y(this,`_currentAdResponseNumber`,void 0),y(this,`_prerollPlayTime`,void 0),y(this,`_wouldBeNewAdPlay`,void 0),y(this,`isAdBreak`,void 0),y(this,`pm`,void 0),this.pm=t,t.on(`viewinit`,function(){n.isAdBreak=!1,n._currentAdRequestNumber=0,n._currentAdResponseNumber=0,n._adRequests=[],n._adResponses=[],n._adHasPlayed=!1,n._wouldBeNewAdPlay=!0,n._prerollPlayTime=void 0}),Mt.forEach(function(e){return t.on(e,n._updateAdData.bind(n))});var r=function(){n.isAdBreak=!1};t.on(`adbreakstart`,function(){n.isAdBreak=!0}),t.on(`play`,r),t.on(`playing`,r),t.on(`viewend`,r),t.on(`adrequest`,function(e,r){r=Object.assign({ad_request_id:`generatedAdRequestId`+n._currentAdRequestNumber++},r),jt(n._adRequests,r),Ze(t.data,`view_ad_request_count`),n.inPrerollPosition()&&(t.data.view_preroll_requested=!0,n._adHasPlayed||Ze(t.data,`view_preroll_request_count`))}),t.on(`adresponse`,function(e,r){r=Object.assign({ad_request_id:`generatedAdRequestId`+n._currentAdResponseNumber++},r),jt(n._adResponses,r);var i=n.findAdRequest(r.ad_request_id);i&&Ze(t.data,`view_ad_request_time`,Math.max(0,r.viewer_time-i.viewer_time))}),t.on(`adplay`,function(e,r){n._adHasPlayed=!0,n._wouldBeNewAdPlay&&(n._wouldBeNewAdPlay=!1,Ze(t.data,`view_ad_played_count`)),n.inPrerollPosition()&&!t.data.view_preroll_played&&(t.data.view_preroll_played=!0,n._adRequests.length>0&&(t.data.view_preroll_request_time=Math.max(0,r.viewer_time-n._adRequests[0].viewer_time)),t.data.view_start&&(t.data.view_startup_preroll_request_time=Math.max(0,r.viewer_time-t.data.view_start)),n._prerollPlayTime=r.viewer_time)}),t.on(`adplaying`,function(e,r){n.inPrerollPosition()&&t.data.view_preroll_load_time===void 0&&n._prerollPlayTime!==void 0&&(t.data.view_preroll_load_time=r.viewer_time-n._prerollPlayTime,t.data.view_startup_preroll_load_time=r.viewer_time-n._prerollPlayTime)}),t.on(`adclicked`,function(e,r){n._wouldBeNewAdPlay||Ze(t.data,`view_ad_clicked_count`)}),t.on(`adskipped`,function(e,r){n._wouldBeNewAdPlay||Ze(t.data,`view_ad_skipped_count`)}),t.on(`adended`,function(){n._wouldBeNewAdPlay=!0}),t.on(`aderror`,function(){n._wouldBeNewAdPlay=!0})}return Le(e,[{key:`inPrerollPosition`,value:function(){return this.pm.data.view_content_playback_time===void 0||this.pm.data.view_content_playback_time<=1e3}},{key:`findAdRequest`,value:function(e){for(var t=0;t<this._adRequests.length;t++)if(this._adRequests[t].ad_request_id===e)return this._adRequests[t]}},{key:`_updateAdData`,value:function(e,t){if(this.inPrerollPosition()){if(!this.pm.data.view_preroll_ad_tag_hostname&&t.ad_tag_url){var n=Ce(Ye(t.ad_tag_url),2),r=n[0],i=n[1];this.pm.data.view_preroll_ad_tag_domain=i,this.pm.data.view_preroll_ad_tag_hostname=r}if(!this.pm.data.view_preroll_ad_asset_hostname&&t.ad_asset_url){var a=Ce(Ye(t.ad_asset_url),2),o=a[0],s=a[1];this.pm.data.view_preroll_ad_asset_domain=s,this.pm.data.view_preroll_ad_asset_hostname=o}this.pm.data.ad_type=`preroll`}this.pm.data.ad_asset_url=t?.ad_asset_url,this.pm.data.ad_tag_url=t?.ad_tag_url,this.pm.data.ad_creative_id=t?.ad_creative_id,this.pm.data.ad_id=t?.ad_id,this.pm.data.ad_universal_id=t?.ad_universal_id,t!=null&&t.ad_type&&(this.pm.data.ad_type=t?.ad_type)}}]),e}(),Pt=function e(t){var n=this;Fe(this,e),y(this,`lastWallClockTime`,void 0);var r=function(){n.lastWallClockTime=we.now(),t.on(`before*`,i)},i=function(e){var r=we.now(),i=n.lastWallClockTime;n.lastWallClockTime=r,r-i>3e4&&(t.emit(`devicesleep`,{viewer_time:i}),Object.assign(t.data,{viewer_time:i}),t.send(`devicesleep`),t.emit(`devicewake`,{viewer_time:r}),Object.assign(t.data,{viewer_time:r}),t.send(`devicewake`))};t.one(`playbackheartbeat`,r),t.on(`playbackheartbeatend`,function(){t.off(`before*`,i),t.one(`playbackheartbeat`,r)})},Ft=function(e){return e()}(function(){var e=function(){for(var e=0,t={};e<arguments.length;e++){var n=arguments[e];for(var r in n)t[r]=n[r]}return t};function t(n){function r(t,i,a){var o;if(typeof document<`u`){if(arguments.length>1){if(a=e({path:`/`},r.defaults,a),typeof a.expires==`number`){var s=new Date;s.setMilliseconds(s.getMilliseconds()+a.expires*864e5),a.expires=s}try{o=JSON.stringify(i),/^[\{\[]/.test(o)&&(i=o)}catch{}return i=n.write?n.write(i,t):encodeURIComponent(String(i)).replace(/%(23|24|26|2B|3A|3C|3E|3D|2F|3F|40|5B|5D|5E|60|7B|7D|7C)/g,decodeURIComponent),t=encodeURIComponent(String(t)),t=t.replace(/%(23|24|26|2B|5E|60|7C)/g,decodeURIComponent),t=t.replace(/[\(\)]/g,escape),document.cookie=[t,`=`,i,a.expires?`; expires=`+a.expires.toUTCString():``,a.path?`; path=`+a.path:``,a.domain?`; domain=`+a.domain:``,a.secure?`; secure`:``].join(``)}t||(o={});for(var c=document.cookie?document.cookie.split(`; `):[],l=/(%[0-9A-Z]{2})+/g,u=0;u<c.length;u++){var d=c[u].split(`=`),f=d.slice(1).join(`=`);f.charAt(0)===`"`&&(f=f.slice(1,-1));try{var p=d[0].replace(l,decodeURIComponent);if(f=n.read?n.read(f,p):n(f,p)||f.replace(l,decodeURIComponent),this.json)try{f=JSON.parse(f)}catch{}if(t===p){o=f;break}t||(o[p]=f)}catch{}}return o}}return r.set=r,r.get=function(e){return r.call(r,e)},r.getJSON=function(){return r.apply({json:!0},[].slice.call(arguments))},r.defaults={},r.remove=function(t,n){r(t,``,e(n,{expires:-1}))},r.withConverter=t,r}return t(function(){})}),It=`muxData`,Lt=function(e){return Object.entries(e).map(function(e){var t=Ce(e,2);return`${t[0]}=${t[1]}`}).join(`&`)},Rt=function(e){return e.split(`&`).reduce(function(e,t){var n=Ce(t.split(`=`),2),r=n[0],i=n[1],a=+i;return e[r]=i&&a==i?a:i,e},{})},zt=function(){var e;try{e=Rt(Ft.get(It)||``)}catch{e={}}return e},Bt=function(e){try{Ft.set(It,Lt(e),{expires:365})}catch{}},Vt=function(){var e=zt();return e.mux_viewer_id=e.mux_viewer_id||Te(),e.msn=e.msn||Math.random(),Bt(e),{mux_viewer_id:e.mux_viewer_id,mux_sample_number:e.msn}},Ht=function(){var e=zt(),t=we.now();return e.session_start&&(e.sst=e.session_start,delete e.session_start),e.session_id&&(e.sid=e.session_id,delete e.session_id),e.session_expires&&(e.sex=e.session_expires,delete e.session_expires),(!e.sex||e.sex<t)&&(e.sid=Te(),e.sst=t),e.sex=t+15e5,Bt(e),{session_id:e.sid,session_start:e.sst,session_expires:e.sex}};function Ut(e,t){var n=t.beaconCollectionDomain,r=t.beaconDomain;if(n)return(/localhost(?::\d+)?$/.test(n)?`http://`:`https://`)+n;e||=`inferred`;var i=r||`litix.io`;return e.match(/^[a-z0-9]+$/)?`https://`+e+`.`+i:`https://img.litix.io/a.gif`}var Wt=Kt({a:`env`,b:`beacon`,c:`custom`,d:`ad`,e:`event`,f:`experiment`,i:`internal`,m:`mux`,n:`response`,p:`player`,q:`request`,r:`retry`,s:`session`,t:`timestamp`,u:`viewer`,v:`video`,w:`page`,x:`view`,y:`sub`}),Gt=Kt({ad:`ad`,af:`affiliate`,ag:`aggregate`,ap:`api`,al:`application`,ao:`audio`,ar:`architecture`,as:`asset`,au:`autoplay`,av:`average`,bi:`bitrate`,bn:`brand`,br:`break`,bw:`browser`,by:`bytes`,bz:`business`,ca:`cached`,cb:`cancel`,cc:`codec`,cd:`code`,cg:`category`,ch:`changed`,ci:`client`,ck:`clicked`,cl:`canceled`,cm:`cmcd`,cn:`config`,co:`count`,ce:`counter`,cp:`complete`,cq:`creator`,cr:`creative`,cs:`captions`,ct:`content`,cu:`current`,cv:`cumulative`,cx:`connection`,cz:`context`,da:`data`,dg:`downscaling`,dm:`domain`,dn:`cdn`,do:`downscale`,dr:`drm`,dp:`dropped`,du:`duration`,dv:`device`,dy:`dynamic`,eb:`enabled`,ec:`encoding`,ed:`edge`,en:`end`,eg:`engine`,em:`embed`,er:`error`,ep:`experiments`,es:`errorcode`,et:`errortext`,ee:`event`,ev:`events`,ex:`expires`,ez:`exception`,fa:`failed`,fi:`first`,fm:`family`,ft:`format`,fp:`fps`,fq:`frequency`,fr:`frame`,fs:`fullscreen`,ha:`has`,hb:`holdback`,he:`headers`,ho:`host`,hn:`hostname`,ht:`height`,id:`id`,ii:`init`,in:`instance`,ip:`ip`,is:`is`,ke:`key`,la:`language`,lb:`labeled`,le:`level`,li:`live`,ld:`loaded`,lo:`load`,lw:`low`,ls:`lists`,lt:`latency`,ma:`max`,md:`media`,me:`message`,mf:`manifest`,mi:`mime`,ml:`midroll`,mm:`min`,mn:`manufacturer`,mo:`model`,mp:`mode`,ms:`ms`,mx:`mux`,ne:`newest`,nm:`name`,no:`number`,on:`on`,or:`origin`,os:`os`,pa:`paused`,pb:`playback`,pd:`producer`,pe:`percentage`,pf:`played`,pg:`program`,ph:`playhead`,pi:`plugin`,pl:`preroll`,pn:`playing`,po:`poster`,pp:`pip`,pr:`preload`,ps:`position`,pt:`part`,pv:`previous`,py:`property`,px:`pop`,pz:`plan`,ra:`rate`,rd:`requested`,re:`rebuffer`,rf:`rendition`,rg:`range`,rm:`remote`,ro:`ratio`,rp:`response`,rq:`request`,rs:`requests`,sa:`sample`,sd:`skipped`,se:`session`,sh:`shift`,si:`sid`,sk:`seek`,sm:`stream`,so:`source`,sq:`sequence`,sr:`series`,ss:`status`,st:`start`,su:`startup`,sv:`server`,sw:`software`,sy:`severity`,ta:`tag`,tc:`tech`,te:`text`,tg:`target`,th:`throughput`,ti:`time`,tl:`total`,to:`to`,tt:`title`,ty:`type`,ug:`upscaling`,un:`universal`,up:`upscale`,ur:`url`,us:`user`,va:`variant`,vd:`viewed`,vi:`video`,ve:`version`,vw:`view`,vr:`viewer`,wd:`width`,wa:`watch`,wt:`waiting`});function Kt(e){var t={};for(var n in e)e.hasOwnProperty(n)&&(t[e[n]]=n);return t}function qt(e){var t={},n={};return Object.keys(e).forEach(function(r){var i=!1;if(e.hasOwnProperty(r)&&e[r]!==void 0){var a=r.split(`_`),o=a[0],s=Wt[o];s||=(_.info("Data key word `"+a[0]+"` not expected in "+r),o+`_`),a.splice(1).forEach(function(e){e===`url`&&(i=!0),Gt[e]?s+=Gt[e]:Number.isInteger(Number(e))?s+=e:(_.info("Data key word `"+e+"` not expected in "+r),s+=`_`+e+`_`)}),i?n[s]=e[r]:t[s]=e[r]}}),Object.assign(t,n)}var Jt=ee(_e()),Yt=typeof document<`u`?document:Jt.default,Xt={maxBeaconSize:300,maxQueueLength:3600,baseTimeBetweenBeacons:1e4,maxPayloadKBSize:500},Zt=57344,Qt=[`hb`,`requestcompleted`,`requestfailed`,`requestcanceled`],$t=`https://img.litix.io`,en=function(e){var t=arguments.length>1&&arguments[1]!==void 0?arguments[1]:{};this._beaconUrl=e||$t,this._eventQueue=[],this._postInFlight=!1,this._resendAfterPost=!1,this._failureCount=0,this._sendTimeout=!1,this._options=Object.assign({},Xt,t)};en.prototype.queueEvent=function(e,t){var n=Object.assign({},t);return this._eventQueue.length<=this._options.maxQueueLength||e===`eventrateexceeded`?(this._eventQueue.push(n),this._sendTimeout||this._startBeaconSending(),this._eventQueue.length<=this._options.maxQueueLength):!1},en.prototype.flushEvents=function(){arguments.length>0&&arguments[0]!==void 0&&arguments[0]&&this._eventQueue.length===1?this._eventQueue.pop():(this._eventQueue.length&&this._sendBeaconQueue(),this._startBeaconSending())},en.prototype.destroy=function(){var e=arguments.length>0&&arguments[0]!==void 0&&arguments[0];this.destroyed=!0,e?this._clearBeaconQueue():this.flushEvents(),g.clearTimeout(this._sendTimeout)},en.prototype._clearBeaconQueue=function(){var e=this._eventQueue.length>this._options.maxBeaconSize?this._eventQueue.length-this._options.maxBeaconSize:0,t=this._eventQueue.slice(e);e>0&&Object.assign(t[t.length-1],qt({mux_view_message:`event queue truncated`}));var n=this._createPayload(t);nn(this._beaconUrl,n,!0,function(){})},en.prototype._sendBeaconQueue=function(){var e=this;if(this._postInFlight)this._resendAfterPost=!0;else{var t=this._eventQueue.slice(0,this._options.maxBeaconSize);this._eventQueue=this._eventQueue.slice(this._options.maxBeaconSize),this._postInFlight=!0;var n=this._createPayload(t),r=we.now();nn(this._beaconUrl,n,!1,function(n,i){i?(e._eventQueue=t.concat(e._eventQueue),e._failureCount+=1,_.info(`Error sending beacon: `+i)):e._failureCount=0,e._roundTripTime=we.now()-r,e._postInFlight=!1,e._resendAfterPost&&(e._resendAfterPost=!1,e._eventQueue.length>0&&e._sendBeaconQueue())})}},en.prototype._getNextBeaconTime=function(){if(!this._failureCount)return this._options.baseTimeBetweenBeacons;var e=2**(this._failureCount-1);return e*=Math.random(),(1+e)*this._options.baseTimeBetweenBeacons},en.prototype._startBeaconSending=function(){var e=this;g.clearTimeout(this._sendTimeout),!this.destroyed&&(this._sendTimeout=g.setTimeout(function(){e._eventQueue.length&&e._sendBeaconQueue(),e._startBeaconSending()},this._getNextBeaconTime()))},en.prototype._createPayload=function(e){var t=this,n={transmission_timestamp:Math.round(we.now())};this._roundTripTime&&(n.rtt_ms=Math.round(this._roundTripTime));var r,i,a,o=function(){r=JSON.stringify({metadata:n,events:i||e}),a=r.length/1024},s=function(){return a<=t._options.maxPayloadKBSize};return o(),s()||(_.info(`Payload size is too big (`+a+` kb). Removing unnecessary events.`),i=e.filter(function(e){return Qt.indexOf(e.e)===-1}),o()),s()||(_.info(`Payload size still too big (`+a+` kb). Cropping fields..`),i.forEach(function(e){for(var t in e){var n=e[t],r=51200;typeof n==`string`&&n.length>r&&(e[t]=n.substring(0,r))}}),o()),r};var tn=typeof Yt.exitPictureInPicture==`function`?function(e){return e.length<=Zt}:function(e){return!1},nn=function(e,t,n,r){if(n&&navigator&&navigator.sendBeacon&&navigator.sendBeacon(e,t))r();else if(g.fetch)g.fetch(e,{method:`POST`,body:t,headers:{"Content-Type":`text/plain`},keepalive:tn(t)}).then(function(e){return r(null,e.ok?null:`Error`)}).catch(function(e){return r(null,e)});else if(g.XMLHttpRequest){var i=new g.XMLHttpRequest;i.onreadystatechange=function(){if(i.readyState===4)return r(null,i.status===200?void 0:`error`)},i.open(`POST`,e),i.setRequestHeader(`Content-Type`,`text/plain`),i.send(t)}else r()},rn=en,an=[`env_key`,`view_id`,`view_sequence_number`,`player_sequence_number`,`beacon_domain`,`player_playhead_time`,`viewer_time`,`mux_api_version`,`event`,`video_id`,`player_instance_id`,`player_error_code`,`player_error_message`,`player_error_context`,`player_error_severity`,`player_error_business_exception`,`view_playing_time_ms_cumulative`,`ad_playing_time_ms_cumulative`],on=[`adplay`,`adplaying`,`adpause`,`adfirstquartile`,`admidpoint`,`adthirdquartile`,`adended`,`adresponse`,`adrequest`],sn=[`ad_id`,`ad_creative_id`,`ad_universal_id`],cn=[`viewstart`,`error`,`ended`,`viewend`],ln=6e5,un=function(){function e(t,n){var r=arguments.length>2&&arguments[2]!==void 0?arguments[2]:{};Fe(this,e);var i,a,o,s,c,l,u;y(this,`mux`,void 0),y(this,`envKey`,void 0),y(this,`options`,void 0),y(this,`eventQueue`,void 0),y(this,`sampleRate`,void 0),y(this,`disableCookies`,void 0),y(this,`respectDoNotTrack`,void 0),y(this,`previousBeaconData`,void 0),y(this,`lastEventTime`,void 0),y(this,`rateLimited`,void 0),y(this,`pageLevelData`,void 0),y(this,`viewerData`,void 0),this.mux=t,this.envKey=n,this.options=r,this.previousBeaconData=null,this.lastEventTime=0,this.rateLimited=!1,this.eventQueue=new rn(Ut(this.envKey,this.options)),this.sampleRate=this.options.sampleRate??1,this.disableCookies=this.options.disableCookies??!1,this.respectDoNotTrack=this.options.respectDoNotTrack??!1,this.previousBeaconData=null,this.lastEventTime=0,this.rateLimited=!1,this.pageLevelData={mux_api_version:this.mux.API_VERSION,mux_embed:this.mux.NAME,mux_embed_version:this.mux.VERSION,viewer_application_name:this.options.platform?.name,viewer_application_version:this.options.platform?.version,viewer_application_engine:this.options.platform?.layout,viewer_device_name:this.options.platform?.product,viewer_device_category:``,viewer_device_manufacturer:this.options.platform?.manufacturer,viewer_os_family:(a=this.options.platform)==null||(i=a.os)==null?void 0:i.family,viewer_os_architecture:(s=this.options.platform)==null||(o=s.os)==null?void 0:o.architecture,viewer_os_version:(l=this.options.platform)==null||(c=l.os)==null?void 0:c.version,page_url:g==null||(u=g.location)==null?void 0:u.href},this.viewerData=this.disableCookies?{}:Vt()}return Le(e,[{key:`send`,value:function(e,t){if(e&&t!=null&&t.view_id){if(this.respectDoNotTrack&&Pe())return _.info("Not sending `"+e+"` because Do Not Track is enabled");if(!t||typeof t!=`object`)return _.error(`A data object was expected in send() but was not provided`);var n=this.disableCookies?{}:Ht(),r=et(Qe({},this.pageLevelData,t,n,this.viewerData),{event:e,env_key:this.envKey});r.user_id&&(r.viewer_user_id=r.user_id,delete r.user_id);var i=(r.mux_sample_number??0)>=this.sampleRate,a=qt(this._deduplicateBeaconData(e,r));if(this.lastEventTime=this.mux.utils.now(),i)return _.info(`Not sending event due to sample rate restriction`,e,r,a);if(this.envKey||_.info(`Missing environment key (envKey) - beacons will be dropped if the video source is not a valid mux video URL`,e,r,a),!this.rateLimited){if(_.info(`Sending event`,e,r,a),this.rateLimited=!this.eventQueue.queueEvent(e,a),this.mux.WINDOW_UNLOADING&&e===`viewend`)this.eventQueue.destroy(!0);else{if(this.mux.WINDOW_HIDDEN&&e===`hb`)this.eventQueue.flushEvents(!0);else if(cn.indexOf(e)>=0){if(e===`error`&&t.player_error_severity===`warning`)return;this.eventQueue.flushEvents()}if(this.rateLimited)return r.event=`eventrateexceeded`,a=qt(r),this.eventQueue.queueEvent(r.event,a),_.error(`Beaconing disabled due to rate limit.`)}}}}},{key:`destroy`,value:function(){this.eventQueue.destroy(!1)}},{key:`_deduplicateBeaconData`,value:function(e,t){var n=this,r={},i=t.view_id;if(i===`-1`||e===`viewstart`||e===`viewend`||!this.previousBeaconData||this.mux.utils.now()-this.lastEventTime>=ln)r=Qe({},t),i&&(this.previousBeaconData=r),i&&e===`viewend`&&(this.previousBeaconData=null);else{var a=e.indexOf(`request`)===0;Object.entries(t).forEach(function(t){var i=Ce(t,2),o=i[0],s=i[1];n.previousBeaconData&&(s!==n.previousBeaconData[o]||an.indexOf(o)>-1||n.objectHasChanged(a,o,s,n.previousBeaconData[o])||n.eventRequiresKey(e,o))&&(r[o]=s,n.previousBeaconData[o]=s)})}return r}},{key:`objectHasChanged`,value:function(e,t,n,r){return!e||t.indexOf(`request_`)!==0?!1:t===`request_response_headers`||typeof n!=`object`||typeof r!=`object`||Object.keys(n||{}).length!==Object.keys(r||{}).length}},{key:`eventRequiresKey`,value:function(e,t){return!!(e===`renditionchange`&&t.indexOf(`video_source_`)===0||sn.includes(t)&&on.includes(e)||e===`playbackmodechange`&&t.indexOf(`player_playback_mode`)===0)}}]),e}(),dn=function e(t){Fe(this,e);var n=0,r=0,i=0,a=0,o=0,s=0,c=0;t.on(`requestcompleted`,function(e,s){var c=s.request_start,l=s.request_response_start,u=s.request_response_end,d=s.request_bytes_loaded;a++;var f,p;if(l?(f=l-(c??0),p=(u??0)-l):p=(u??0)-(c??0),p>0&&d&&d>0){var m=d/p*8e3;o++,r+=d,i+=p,t.data.view_min_request_throughput=Math.min(t.data.view_min_request_throughput||1/0,m),t.data.view_average_request_throughput=r/i*8e3,t.data.view_request_count=a,f>0&&(n+=f,t.data.view_max_request_latency=Math.max(t.data.view_max_request_latency||0,f),t.data.view_average_request_latency=n/o)}}),t.on(`requestfailed`,function(e,n){a++,s++,t.data.view_request_count=a,t.data.view_request_failed_count=s}),t.on(`requestcanceled`,function(e,n){a++,c++,t.data.view_request_count=a,t.data.view_request_canceled_count=c})},fn=36e5,pn=function e(t){var n=this;Fe(this,e),y(this,`_lastEventTime`,void 0),t.on(`before*`,function(e,r){var i=r.viewer_time,a=we.now(),o=n._lastEventTime;if(n._lastEventTime=a,o&&a-o>fn){var s=Object.keys(t.data).reduce(function(e,n){return n.indexOf(`video_`)===0?Object.assign(e,y({},n,t.data[n])):e},{});t.mux.log.info(`Received event after at least an hour inactivity, creating a new view`);var c=t.playbackHeartbeat._playheadShouldBeProgressing;t._resetView(Object.assign({viewer_time:i},s)),t.playbackHeartbeat._playheadShouldBeProgressing=c,t.playbackHeartbeat._playheadShouldBeProgressing&&e.type!==`play`&&e.type!==`adbreakstart`&&(t.emit(`play`,{viewer_time:i}),e.type!==`playing`&&t.emit(`playing`,{viewer_time:i}))}})},mn=function e(t){Fe(this,e);var n=function(e){var n=gn(e),r=_n(e);if(n!=null&&!hn(n,a)&&o<=r){a=n,o=r;var i={video_cdn:n};t.emit(`cdnchange`,i)}},r=null,i=null,a=null,o=0;t.on(`viewinit`,function(){r=null,i=null,a=null,o=0}),t.on(`beforecdnchange`,function(e,t){var n=t?.video_cdn;n&&(t.video_previous_cdn===void 0||t.video_previous_cdn===null)&&(hn(n,i)?t.video_previous_cdn=r??void 0:(t.video_previous_cdn=i??void 0,r=i,i=n))}),t.on(`requestcompleted`,function(e,t){n(t)})};function hn(e,t){return e?.toLowerCase()===t?.toLowerCase()}function gn(e){var t;return e!=null&&e.request_type&&(e.request_type===`media`||e.request_type===`video`)&&(t=e.request_response_headers)!=null&&t[`x-cdn`]?e.request_response_headers[`x-cdn`]:e!=null&&e.video_cdn?e.video_cdn:null}function _n(e){return e!=null&&e.request_start?e.request_start:e!=null&&e.viewer_time?e.viewer_time:Date.now()}var vn=mn,yn=function(e){try{return JSON.parse(e),!0}catch{return!1}},bn=function e(t){var n=this;Fe(this,e),y(this,`_emittingAutomaticEvent`,!1),y(this,`_hasInitialized`,!1),y(this,`_currentMode`,`standard`),t.on(`viewstart`,function(){n._hasInitialized||(n._hasInitialized=!0,n._currentMode=t.data.player_playback_mode||`standard`,n._emittingAutomaticEvent=!0,t.emit(`playbackmodechange`,{player_playback_mode:n._currentMode,player_playback_mode_data:`{}`}),n._emittingAutomaticEvent=!1)}),t.on(`viewend`,function(){n._hasInitialized=!1}),t.on(`playbackmodechange`,function(e,r){n._emittingAutomaticEvent||(r.player_playback_mode_data?yn(r.player_playback_mode_data)||(t.mux.log.warn(`Invalid JSON string for player_playback_mode_data`),r.player_playback_mode_data=`{}`):r.player_playback_mode_data=`{}`,t.data.player_playback_mode_data=r.player_playback_mode_data,t.data.player_playback_mode=r.player_playback_mode,n._currentMode=r.player_playback_mode)})},xn=function(){function e(t){Fe(this,e),y(this,`pm`,void 0),y(this,`_currentRangeStart`,void 0),y(this,`_lastPlayheadTime`,void 0),this.pm=t,this._currentRangeStart=null,this._lastPlayheadTime=null,t.on(`playbackheartbeat`,this._updatePlaybackRange.bind(this)),t.on(`playbackheartbeatend`,this._endPlaybackRange.bind(this))}return Le(e,[{key:`_updateLastRangeEnd`,value:function(){var e=this.pm.data.video_playback_ranges;if(e&&e.length>0){var t=this.pm.data.player_playhead_time||0;e[e.length-1][1]=t}}},{key:`_updatePlaybackRange`,value:function(){var e,t=this.pm.data.player_playhead_time||0;if(!(!this.pm.disableAdPlaybackRangeFiltering&&(e=this.pm.adTracker)!=null&&e.isAdBreak&&this._lastPlayheadTime!==null&&t<this._lastPlayheadTime)){if(this._lastPlayheadTime!==null&&this._currentRangeStart!==null&&Math.abs(t-this._lastPlayheadTime)>1e3){var n=this.pm.data.video_playback_ranges;n&&n.length>0&&(n[n.length-1][1]=this._lastPlayheadTime),this._currentRangeStart=null}if(this._currentRangeStart===null){var r=this.pm.data.video_playback_ranges||[];r.length>0&&r[r.length-1][1]===t?this._currentRangeStart=r[r.length-1][0]:(this._currentRangeStart=t,r.push([t,t])),this.pm.data.video_playback_ranges=r}else this._updateLastRangeEnd();this._lastPlayheadTime=t}}},{key:`_endPlaybackRange`,value:function(){this._currentRangeStart!==null&&(this._updateLastRangeEnd(),this._currentRangeStart=null,this._lastPlayheadTime=null)}}]),e}(),Sn=Object.freeze({CELLULAR:`cellular`,WIFI:`wifi`,WIRED:`wired`,OTHER:`other`,NO_CONNECTION:`no_connection`,UNKNOWN:`unknown`}),Cn=function(e){if(!e)return Sn.UNKNOWN;switch(e){case`cellular`:case`wimax`:return Sn.CELLULAR;case`wifi`:return Sn.WIFI;case`ethernet`:return Sn.WIRED;case`none`:return Sn.NO_CONNECTION;case`bluetooth`:case`other`:return Sn.OTHER;case`unknown`:return Sn.UNKNOWN;default:return Sn.OTHER}},wn=function(e){return typeof e==`object`&&`connection`in e&&typeof e.connection==`object`},Tn=function(){function e(t){var n=this;Fe(this,e),y(this,`pm`,void 0),y(this,`lastType`,void 0),y(this,`lastLowDataMode`,void 0),this.pm=t,this.pm.one(`viewinit`,function(){var t,r=n.emit.bind(n);r(),g.addEventListener(`online`,r),g.addEventListener(`offline`,r),(t=e.connection)==null||t.addEventListener(`change`,r),n.pm.on(`destroy`,function(){var t;(t=e.connection)==null||t.removeEventListener(`change`,r),g.removeEventListener(`online`,r),g.removeEventListener(`offline`,r)})})}return Le(e,[{key:`type`,get:function(){var t;return g.navigator?.onLine===!1?Sn.NO_CONNECTION:(t=e.connection)!=null&&t.type?Cn(e.connection.type):Sn.UNKNOWN}},{key:`lowDataMode`,get:function(){return e.connection?.saveData}},{key:`emit`,value:function(){var e=this.type,t=this.lowDataMode;e===this.lastType&&t===this.lastLowDataMode||(this.lastType=e,this.lastLowDataMode=t,this.pm.emit(`networkchange`,Qe({viewer_connection_type:e},t!==void 0&&{viewer_connection_low_data_mode:t})))}}],[{key:`connection`,get:function(){return wn(g.navigator)?g.navigator.connection:null}}]),e}(),En=`viewstart.ended.loadstart.pause.play.playing.ratechange.waiting.adplay.adpause.adended.aderror.adplaying.adrequest.adresponse.adbreakstart.adbreakend.adfirstquartile.admidpoint.adthirdquartile.rebufferstart.rebufferend.seeked.error.hb.requestcompleted.requestfailed.requestcanceled.renditionchange.networkchange.cdnchange.playbackmodechange`.split(`.`),Dn=new Set([`requestcompleted`,`requestfailed`,`requestcanceled`]),On=function(e){He(n,e);var t=qe(n);function n(e,r,i){Fe(this,n);var a=t.call(this);y(v(a),`pageLoadEndTime`,void 0),y(v(a),`pageLoadInitTime`,void 0),y(v(a),`_destroyed`,void 0),y(v(a),`_heartBeatTimeout`,void 0),y(v(a),`adTracker`,void 0),y(v(a),`dashjs`,void 0),y(v(a),`data`,void 0),y(v(a),`disablePlayheadRebufferTracking`,void 0),y(v(a),`disableRebufferTracking`,void 0),y(v(a),`disableAdPlaybackRangeFiltering`,void 0),y(v(a),`errorTracker`,void 0),y(v(a),`errorTranslator`,void 0),y(v(a),`emitTranslator`,void 0),y(v(a),`getAdData`,void 0),y(v(a),`getPlayheadTime`,void 0),y(v(a),`getStateData`,void 0),y(v(a),`stateDataTranslator`,void 0),y(v(a),`hlsjs`,void 0),y(v(a),`id`,void 0),y(v(a),`longResumeTracker`,void 0),y(v(a),`minimumRebufferDuration`,void 0),y(v(a),`mux`,void 0),y(v(a),`playbackEventDispatcher`,void 0),y(v(a),`playbackHeartbeat`,void 0),y(v(a),`playbackHeartbeatTime`,void 0),y(v(a),`playheadTime`,void 0),y(v(a),`seekingTracker`,void 0),y(v(a),`sustainedRebufferThreshold`,void 0),y(v(a),`watchTimeTracker`,void 0),y(v(a),`currentFragmentPDT`,void 0),y(v(a),`currentFragmentStart`,void 0),a.pageLoadInitTime=Xe.navigationStart(),a.pageLoadEndTime=Xe.domContentLoadedEventEnd(),a.mux=e,a.id=r,i!=null&&i.beaconDomain&&a.mux.log.warn("The `beaconDomain` setting has been deprecated in favor of `beaconCollectionDomain`. Please change your integration to use `beaconCollectionDomain` instead of `beaconDomain`."),i=Object.assign({debug:!1,minimumRebufferDuration:250,sustainedRebufferThreshold:1e3,playbackHeartbeatTime:25,beaconDomain:`litix.io`,sampleRate:1,disableCookies:!1,respectDoNotTrack:!1,disableRebufferTracking:!1,disablePlayheadRebufferTracking:!1,disableAdPlaybackRangeFiltering:!1,errorTranslator:function(e){return e},emitTranslator:function(){return[...arguments]},stateDataTranslator:function(e){return e}},i),i.data=i.data||{},i.data.property_key&&(i.data.env_key=i.data.property_key,delete i.data.property_key),_.level=i.debug?Ne.DEBUG:Ne.WARN,a.getPlayheadTime=i.getPlayheadTime,a.getStateData=i.getStateData||function(){return{}},a.getAdData=i.getAdData||function(){},a.minimumRebufferDuration=i.minimumRebufferDuration,a.sustainedRebufferThreshold=i.sustainedRebufferThreshold,a.playbackHeartbeatTime=i.playbackHeartbeatTime,a.disableRebufferTracking=i.disableRebufferTracking,a.disableRebufferTracking&&a.mux.log.warn(`Disabling rebuffer tracking. This should only be used in specific circumstances as a last resort when your player is known to unreliably track rebuffering.`),a.disablePlayheadRebufferTracking=i.disablePlayheadRebufferTracking,a.disableAdPlaybackRangeFiltering=i.disableAdPlaybackRangeFiltering,a.errorTranslator=i.errorTranslator,a.emitTranslator=i.emitTranslator,a.stateDataTranslator=i.stateDataTranslator,a.playbackEventDispatcher=new un(e,i.data.env_key,i),a.data={player_instance_id:Te(),mux_sample_rate:i.sampleRate,beacon_domain:i.beaconCollectionDomain||i.beaconDomain},a.data.view_sequence_number=1,a.data.player_sequence_number=1;var o=function(){this.data.view_start===void 0&&(this.data.view_start=this.mux.utils.now(),this.emit(`viewstart`),this.emit(`renditionchange`))}.bind(v(a));if(a.on(`viewinit`,function(e,t){this._resetVideoData(),this._resetViewData(),this._resetErrorData(),this._updateStateData(),Object.assign(this.data,t),this._initializeViewData(),this.one(`play`,o),this.one(`adbreakstart`,o)}),a.on(`videochange`,function(e,t){this._resetView(t)}),a.on(`programchange`,function(e,t){this.data.player_is_paused&&this.mux.log.warn("The `programchange` event is intended to be used when the content changes mid playback without the video source changing, however the video is not currently playing. If the video source is changing please use the videochange event otherwise you will lose startup time information."),this._resetView(Object.assign(t,{view_program_changed:!0})),o(),this.emit(`play`),this.emit(`playing`)}),a.on(`fragmentchange`,function(e,t){this.currentFragmentPDT=t.currentFragmentPDT,this.currentFragmentStart=t.currentFragmentStart}),a.on(`destroy`,a.destroy),typeof window<`u`&&typeof window.addEventListener==`function`&&typeof window.removeEventListener==`function`){var s=function(){var e=a.data.view_start!==void 0;a.mux.WINDOW_HIDDEN=document.visibilityState===`hidden`,e&&a.mux.WINDOW_HIDDEN&&(a.data.player_is_paused||a.emit(`hb`))};window.addEventListener(`visibilitychange`,s,!1);var c=function(e){e.persisted||a.destroy()};window.addEventListener(`pagehide`,c,!1),a.on(`destroy`,function(){window.removeEventListener(`visibilitychange`,s),window.removeEventListener(`pagehide`,c)})}return a.on(`playerready`,function(e,t){Object.assign(this.data,t)}),En.forEach(function(e){a.on(e,function(t,n){e.indexOf(`ad`)!==0&&this._updateStateData(),Object.assign(this.data,n),this._sanitizeData()}),a.on(`after`+e,function(){(e!==`error`||this.errorTracker.viewErrored)&&this.send(e)})}),a.on(`viewend`,function(e,t){Object.assign(a.data,t)}),a.one(`playerready`,function(e){var t=this.mux.utils.now();this.data.player_init_time&&(this.data.player_startup_time=t-this.data.player_init_time),this.pageLoadInitTime=this.data.page_load_init_time||this.pageLoadInitTime,this.pageLoadEndTime=this.data.page_load_end_time||this.pageLoadEndTime,!this.mux.PLAYER_TRACKED&&this.pageLoadInitTime&&(this.mux.PLAYER_TRACKED=!0,(this.data.player_init_time||this.pageLoadEndTime)&&(this.data.page_load_time=Math.min(this.data.player_init_time||1/0,this.pageLoadEndTime||1/0)-this.pageLoadInitTime)),this.send(`playerready`),delete this.data.player_startup_time,delete this.data.page_load_time}),a.longResumeTracker=new pn(v(a)),a.errorTracker=new bt(v(a)),new Pt(v(a)),a.seekingTracker=new At(v(a)),a.playheadTime=new Ct(v(a)),a.playbackHeartbeat=new yt(v(a)),new Ot(v(a)),a.watchTimeTracker=new xt(v(a)),new St(v(a)),new xn(v(a)),a.adTracker=new Nt(v(a)),new Et(v(a)),new Tt(v(a)),new Dt(v(a)),new dn(v(a)),new vn(v(a)),new bn(v(a)),new Tn(v(a)),i.hlsjs&&a.addHLSJS(i),i.dashjs&&a.addDashJS(i),a.emit(`viewinit`,i.data),a}return Le(n,[{key:`emit`,value:function(e,t){var r,i=Object.assign({viewer_time:this.mux.utils.now()},t),a=[e,i];if(this.emitTranslator)try{a=this.emitTranslator(e,i)}catch(e){this.mux.log.warn(`Exception in emit translator callback.`,e)}a!=null&&a.length&&(r=Be(Re(n.prototype),`emit`,this)).call.apply(r,[this].concat(Me(a)))}},{key:`destroy`,value:function(){this._destroyed||(this._destroyed=!0,this.data.view_start!==void 0&&(this.emit(`viewend`),this.send(`viewend`)),this.playbackEventDispatcher.destroy(),this.removeHLSJS(),this.removeDashJS(),window.clearTimeout(this._heartBeatTimeout))}},{key:`send`,value:function(e){if(this.data.view_id){var t=Object.assign({},this.data);if(t.video_source_is_live===void 0&&(t.player_source_duration===1/0||t.video_source_duration===1/0?t.video_source_is_live=!0:(t.player_source_duration>0||t.video_source_duration>0)&&(t.video_source_is_live=!1)),t.video_source_is_live||[`player_program_time`,`player_manifest_newest_program_time`,`player_live_edge_program_time`,`player_program_time`,`video_holdback`,`video_part_holdback`,`video_target_duration`,`video_part_target_duration`].forEach(function(e){t[e]=void 0}),t.video_source_url=t.video_source_url||t.player_source_url,t.video_source_url){var n=Ce(Ye(t.video_source_url),2),r=n[0];t.video_source_domain=n[1],t.video_source_hostname=r}delete t.ad_request_id,t.video_playback_ranges&&(t.video_playback_range=JSON.stringify(t.video_playback_ranges.filter(function(e){return e[0]!==e[1]}).map(function(e){return`${e[0]}:${e[1]}`})),delete t.video_playback_ranges),this.playbackEventDispatcher.send(e,t),this.data.view_sequence_number++,this.data.player_sequence_number++,Dn.has(e)||this._restartHeartBeat(),e===`viewend`&&delete this.data.view_id}}},{key:`_resetView`,value:function(e){this.emit(`viewend`),this.send(`viewend`),this.emit(`viewinit`,e)}},{key:`_updateStateData`,value:function(){var e,t=this.getStateData();if(typeof this.stateDataTranslator==`function`)try{t=this.stateDataTranslator(t)}catch(e){this.mux.log.warn(`Exception in stateDataTranslator translator callback.`,e)}(e=this.data)!=null&&e.video_cdn&&t!=null&&t.video_cdn&&(t.video_cdn,t=We(t,[`video_cdn`])),Object.assign(this.data,t),this.playheadTime._updatePlayheadTime(),this._sanitizeData()}},{key:`_sanitizeData`,value:function(){var e=this;[`player_width`,`player_height`,`video_source_width`,`video_source_height`,`player_playhead_time`,`video_source_bitrate`].forEach(function(t){var n=parseInt(e.data[t],10);e.data[t]=isNaN(n)?void 0:n}),[`player_source_url`,`video_source_url`].forEach(function(t){if(e.data[t]){var n=e.data[t].toLowerCase();(n.indexOf(`data:`)===0||n.indexOf(`blob:`)===0)&&(e.data[t]=`MSE style URL`)}})}},{key:`_resetVideoData`,value:function(){var e=this;Object.keys(this.data).forEach(function(t){t.indexOf(`video_`)===0&&delete e.data[t]})}},{key:`_resetViewData`,value:function(){var e=this;Object.keys(this.data).forEach(function(t){t.indexOf(`view_`)===0&&delete e.data[t]}),this.data.view_sequence_number=1}},{key:`_resetErrorData`,value:function(){delete this.data.player_error_code,delete this.data.player_error_message,delete this.data.player_error_context,delete this.data.player_error_severity,delete this.data.player_error_business_exception}},{key:`_initializeViewData`,value:function(){var e=this,t=this.data.view_id=Te(),n=function(){t===e.data.view_id&&Ze(e.data,`player_view_count`,1)};this.data.player_is_paused?this.one(`play`,n):n()}},{key:`_restartHeartBeat`,value:function(){var e=this;window.clearTimeout(this._heartBeatTimeout),this._heartBeatTimeout=window.setTimeout(function(){e.data.player_is_paused||e.emit(`hb`)},1e4)}},{key:`addHLSJS`,value:function(e){e.hlsjs?this.hlsjs?this.mux.log.warn(`An instance of HLS.js is already being monitored for this player.`):(this.hlsjs=e.hlsjs,lt(this.mux,this.id,e.hlsjs,{},e.Hls||window.Hls)):this.mux.log.warn(`You must pass a valid hlsjs instance in order to track it.`)}},{key:`removeHLSJS`,value:function(){this.hlsjs&&=(ut(this.hlsjs),void 0)}},{key:`addDashJS`,value:function(e){e.dashjs?this.dashjs?this.mux.log.warn(`An instance of Dash.js is already being monitored for this player.`):(this.dashjs=e.dashjs,ht(this.mux,this.id,e.dashjs)):this.mux.log.warn(`You must pass a valid dashjs instance in order to track it.`)}},{key:`removeDashJS`,value:function(){this.dashjs&&=(gt(this.dashjs),void 0)}}]),n}(vt);function kn(){return Yt&&!!(Yt.fullscreenElement||Yt.webkitFullscreenElement||Yt.mozFullScreenElement||Yt.msFullscreenElement)}var An=[`loadstart`,`pause`,`play`,`playing`,`seeking`,`seeked`,`timeupdate`,`ratechange`,`stalled`,`waiting`,`error`,`ended`],jn={1:`MEDIA_ERR_ABORTED`,2:`MEDIA_ERR_NETWORK`,3:`MEDIA_ERR_DECODE`,4:`MEDIA_ERR_SRC_NOT_SUPPORTED`};function Mn(e,t,n){var r=Ce(Oe(t),3),i=r[0],a=r[1],o=r[2],s=e.log,c=e.utils.getComputedStyle,l=e.utils.secondsToMs,u={automaticErrorTracking:!0};if(i){if(o!==`video`&&o!==`audio`)return s.error("The element of `"+a+"` was not a media element.")}else return s.error("No element was found with the `"+a+"` query selector.");i.mux&&(i.mux.destroy(),delete i.mux,s.warn(`Already monitoring this video element, replacing existing event listeners`)),n=Object.assign(u,n,{getPlayheadTime:function(){return l(i.currentTime)},getStateData:function(){var e,t,n=(e=this).getPlayheadTime?.call(e)||l(i.currentTime),r=this.hlsjs&&this.hlsjs.url,a=this.dashjs&&typeof this.dashjs.getSource==`function`&&this.dashjs.getSource(),o={player_is_paused:i.paused,player_width:parseInt(c(i,`width`)),player_height:parseInt(c(i,`height`)),player_autoplay_on:i.autoplay,player_preload_on:i.preload,player_language_code:i.lang,player_is_fullscreen:kn(),video_poster_url:i.poster,video_source_url:r||a||i.currentSrc,video_source_duration:l(i.duration),video_source_height:i.videoHeight,video_source_width:i.videoWidth,view_dropped_frame_count:i==null||(t=i.getVideoPlaybackQuality)==null?void 0:t.call(i).droppedVideoFrames};if(i.getStartDate&&n>0){var s=i.getStartDate();if(s&&typeof s.getTime==`function`&&s.getTime()){var u=s.getTime();o.player_program_time=u+n,i.seekable.length>0&&(o.player_live_edge_program_time=u+i.seekable.end(i.seekable.length-1))}}return o}}),n.data=Object.assign({player_software:`HTML5 Video Element`,player_mux_plugin_name:`VideoElementMonitor`,player_mux_plugin_version:e.VERSION},n.data),i.mux=i.mux||{},i.mux.deleted=!1,i.mux.emit=function(t,n){e.emit(a,t,n)},i.mux.updateData=function(e){i.mux.emit(`hb`,e)};var d=function(){s.error(`The monitor for this video element has already been destroyed.`)};i.mux.destroy=function(){Object.keys(i.mux.listeners).forEach(function(e){i.removeEventListener(e,i.mux.listeners[e],!1)}),delete i.mux.listeners,i.mux.fullscreenChangeListener&&(document.removeEventListener(`fullscreenchange`,i.mux.fullscreenChangeListener,!1),delete i.mux.fullscreenChangeListener),i.mux.destroy=d,i.mux.swapElement=d,i.mux.emit=d,i.mux.addHLSJS=d,i.mux.addDashJS=d,i.mux.removeHLSJS=d,i.mux.removeDashJS=d,i.mux.updateData=d,i.mux.setEmitTranslator=d,i.mux.setStateDataTranslator=d,i.mux.setGetPlayheadTime=d,i.mux.deleted=!0,e.emit(a,`destroy`)},i.mux.swapElement=function(t){var n=Ce(Oe(t),3),r=n[0],a=n[1],o=n[2];if(r){if(o!==`video`&&o!==`audio`)return e.log.error("The element of `"+a+"` was not a media element.")}else return e.log.error("No element was found with the `"+a+"` query selector.");r.muxId=i.muxId,delete i.muxId,r.mux=r.mux||{},r.mux.listeners=Object.assign({},i.mux.listeners),delete i.mux.listeners,Object.keys(r.mux.listeners).forEach(function(e){i.removeEventListener(e,r.mux.listeners[e],!1),r.addEventListener(e,r.mux.listeners[e],!1)}),r.mux.fullscreenChangeListener=i.mux.fullscreenChangeListener,delete i.mux.fullscreenChangeListener,r.mux.swapElement=i.mux.swapElement,r.mux.destroy=i.mux.destroy,delete i.mux,i=r},i.mux.addHLSJS=function(t){e.addHLSJS(a,t)},i.mux.addDashJS=function(t){e.addDashJS(a,t)},i.mux.removeHLSJS=function(){e.removeHLSJS(a)},i.mux.removeDashJS=function(){e.removeDashJS(a)},i.mux.setEmitTranslator=function(t){e.setEmitTranslator(a,t)},i.mux.setStateDataTranslator=function(t){e.setStateDataTranslator(a,t)},i.mux.setGetPlayheadTime=function(t){t||=n.getPlayheadTime,e.setGetPlayheadTime(a,t)},e.init(a,n),e.emit(a,`playerready`),i.paused||(e.emit(a,`play`),i.readyState>2&&e.emit(a,`playing`)),i.mux.listeners={},An.forEach(function(t){t===`error`&&!n.automaticErrorTracking||(i.mux.listeners[t]=function(){var n={};if(t===`error`){if(!i.error||i.error.code===1)return;n.player_error_code=i.error.code,n.player_error_message=jn[i.error.code]||i.error.message}e.emit(a,t,n)},i.addEventListener(t,i.mux.listeners[t],!1))}),i.mux.listeners.enterpictureinpicture=function(){e.emit(a,`playbackmodechange`,{player_playback_mode:`pip`,player_playback_mode_data:`{}`})},i.mux.listeners.leavepictureinpicture=function(){var t=kn()?`fullscreen`:`standard`;e.emit(a,`playbackmodechange`,{player_playback_mode:t,player_playback_mode_data:`{}`})},i.addEventListener(`enterpictureinpicture`,i.mux.listeners.enterpictureinpicture,!1),i.addEventListener(`leavepictureinpicture`,i.mux.listeners.leavepictureinpicture,!1),i.mux.fullscreenChangeListener=function(){var t=kn(),n=document.fullscreenElement;if(t&&(n===i||n!=null&&n.contains(i)))e.emit(a,`playbackmodechange`,{player_playback_mode:`fullscreen`,player_playback_mode_data:`{}`});else if(!t){var r=document.pictureInPictureElement===i?`pip`:`standard`;e.emit(a,`playbackmodechange`,{player_playback_mode:r,player_playback_mode_data:`{}`})}},document.addEventListener(`fullscreenchange`,i.mux.fullscreenChangeListener,!1)}function Nn(e,t,n,r){var i=r;if(e&&typeof e[t]==`function`)try{i=e[t].apply(e,n)}catch(e){_.info(`safeCall error`,e)}return i}var Pn;g&&g.WeakMap&&(Pn=new WeakMap);function Fn(e,t){if(!e||!t||!g||typeof g.getComputedStyle!=`function`)return``;var n;return Pn&&Pn.has(e)&&(n=Pn.get(e)),n||(n=g.getComputedStyle(e,null),Pn&&Pn.set(e,n)),n.getPropertyValue(t)}function In(e){return Math.floor(e*1e3)}var Ln={TARGET_DURATION:`#EXT-X-TARGETDURATION`,PART_INF:`#EXT-X-PART-INF`,SERVER_CONTROL:`#EXT-X-SERVER-CONTROL`,INF:`#EXTINF`,PROGRAM_DATE_TIME:`#EXT-X-PROGRAM-DATE-TIME`,VERSION:`#EXT-X-VERSION`,SESSION_DATA:`#EXT-X-SESSION-DATA`},Rn=function(e){return this.buffer=``,this.manifest={segments:[],serverControl:{},sessionData:{}},this.currentUri={},this.process(e),this.manifest};Rn.prototype.process=function(e){var t;for(this.buffer+=e,t=this.buffer.indexOf(`
`);t>-1;t=this.buffer.indexOf(`
`))this.processLine(this.buffer.substring(0,t)),this.buffer=this.buffer.substring(t+1)},Rn.prototype.processLine=function(e){var t=Gn(e,e.indexOf(`:`)),n=t[0],r=t.length===2?Vn(t[1]):void 0;if(n[0]!==`#`)this.currentUri.uri=n,this.manifest.segments.push(this.currentUri),this.manifest.targetDuration&&!(`duration`in this.currentUri)&&(this.currentUri.duration=this.manifest.targetDuration),this.currentUri={};else switch(n){case Ln.TARGET_DURATION:if(!isFinite(r)||r<0)return;this.manifest.targetDuration=r,this.setHoldBack();break;case Ln.PART_INF:zn(this.manifest,t),this.manifest.partInf.partTarget&&(this.manifest.partTargetDuration=this.manifest.partInf.partTarget),this.setHoldBack();break;case Ln.SERVER_CONTROL:zn(this.manifest,t),this.setHoldBack();break;case Ln.INF:r===0?this.currentUri.duration=.01:r>0&&(this.currentUri.duration=r);break;case Ln.PROGRAM_DATE_TIME:var i=r,a=new Date(i);this.manifest.dateTimeString||(this.manifest.dateTimeString=i,this.manifest.dateTimeObject=a),this.currentUri.dateTimeString=i,this.currentUri.dateTimeObject=a;break;case Ln.VERSION:zn(this.manifest,t);break;case Ln.SESSION_DATA:var o=ot(Kn(t[1]));Object.assign(this.manifest.sessionData,o)}},Rn.prototype.setHoldBack=function(){var e=this.manifest,t=e.serverControl,n=e.targetDuration,r=e.partTargetDuration;if(t){var i=`holdBack`,a=`partHoldBack`,o=n&&n*3,s=r&&r*2;n&&!t.hasOwnProperty(i)&&(t[i]=o),o&&t[i]<o&&(t[i]=o),r&&!t.hasOwnProperty(a)&&(t[a]=r*3),r&&t[a]<s&&(t[a]=s)}};var zn=function(e,t){var n=Bn(t[0].replace(`#EXT-X-`,``)),r;Wn(t[1])?(r={},r=Object.assign(Un(t[1]),r)):r=Vn(t[1]),e[n]=r},Bn=function(e){return e.toLowerCase().replace(/-(\w)/g,function(e){return e[1].toUpperCase()})},Vn=function(e){if(e.toLowerCase()===`yes`||e.toLowerCase()===`no`)return e.toLowerCase()===`yes`;var t=e.indexOf(`:`)===-1?parseFloat(e):e;return isNaN(t)?e:t},Hn=function(e){var t={},n=e.split(`=`);if(n.length>1){var r=Bn(n[0]);t[r]=Vn(n[1])}return t},Un=function(e){for(var t=e.split(`,`),n={},r=0;t.length>r;r++){var i=t[r],a=Hn(i);n=Object.assign(a,n)}return n},Wn=function(e){return e.indexOf(`=`)>-1},Gn=function(e,t){return t===-1?[e]:[e.substring(0,t),e.substring(t+1)]},Kn=function(e){var t={};if(e){var n=e.search(`,`);return[e.slice(0,n),e.slice(n+1)].forEach(function(e,n){for(var r=e.replace(/['"]+/g,``).split(`=`),i=0;i<r.length;i++)r[i]===`DATA-ID`&&(t[`DATA-ID`]=r[1-i]),r[i]===`VALUE`&&(t.VALUE=r[1-i])}),{data:t}}},qn={safeCall:Nn,safeIncrement:Ze,getComputedStyle:Fn,secondsToMs:In,assign:Object.assign,headersStringToObject:it,cdnHeadersToRequestId:at,extractHostnameAndDomain:Ye,extractHostname:Je,manifestParser:Rn,generateShortID:Ee,generateUUID:Te,now:we.now,findMediaElement:Oe},Jn={PLAYER_READY:`playerready`,VIEW_INIT:`viewinit`,VIDEO_CHANGE:`videochange`,PLAY:`play`,PAUSE:`pause`,PLAYING:`playing`,TIME_UPDATE:`timeupdate`,SEEKING:`seeking`,SEEKED:`seeked`,REBUFFER_START:`rebufferstart`,REBUFFER_END:`rebufferend`,ERROR:`error`,ENDED:`ended`,RENDITION_CHANGE:`renditionchange`,ORIENTATION_CHANGE:`orientationchange`,PLAYBACK_MODE_CHANGE:`playbackmodechange`,NETWORK_CHANGE:`networkchange`,AD_REQUEST:`adrequest`,AD_RESPONSE:`adresponse`,AD_BREAK_START:`adbreakstart`,AD_PLAY:`adplay`,AD_PLAYING:`adplaying`,AD_PAUSE:`adpause`,AD_FIRST_QUARTILE:`adfirstquartile`,AD_MID_POINT:`admidpoint`,AD_THIRD_QUARTILE:`adthirdquartile`,AD_ENDED:`adended`,AD_BREAK_END:`adbreakend`,AD_ERROR:`aderror`,REQUEST_COMPLETED:`requestcompleted`,REQUEST_FAILED:`requestfailed`,REQUEST_CANCELLED:`requestcanceled`,HEARTBEAT:`hb`,DESTROY:`destroy`},Yn=`mux-embed`,Xn=`5.18.2`,Zn=`2.1`,Qn={},$n=function(e){var t=arguments;typeof e==`string`?$n.hasOwnProperty(e)?g.setTimeout(function(){t=Array.prototype.splice.call(t,1),$n[e].apply(null,t)},0):_.warn("`"+e+"` is an unknown task"):typeof e==`function`?g.setTimeout(function(){e($n)},0):_.warn("`"+e+"` is invalid.")},er={loaded:we.now(),NAME:Yn,VERSION:Xn,API_VERSION:Zn,PLAYER_TRACKED:!1,monitor:function(e,t){return Mn($n,e,t)},destroyMonitor:function(e){var t=Ce(Oe(e),1)[0];t&&t.mux&&typeof t.mux.destroy==`function`?t.mux.destroy():_.error("A video element monitor for `"+e+"` has not been initialized via `mux.monitor`.")},addHLSJS:function(e,t){var n=De(e);Qn[n]?Qn[n].addHLSJS(t):_.error("A monitor for `"+n+"` has not been initialized.")},addDashJS:function(e,t){var n=De(e);Qn[n]?Qn[n].addDashJS(t):_.error("A monitor for `"+n+"` has not been initialized.")},removeHLSJS:function(e){var t=De(e);Qn[t]?Qn[t].removeHLSJS():_.error("A monitor for `"+t+"` has not been initialized.")},removeDashJS:function(e){var t=De(e);Qn[t]?Qn[t].removeDashJS():_.error("A monitor for `"+t+"` has not been initialized.")},init:function(e,t){Pe()&&t&&t.respectDoNotTrack&&_.info(`The browser's Do Not Track flag is enabled - Mux beaconing is disabled.`);var n=De(e);Qn[n]=new On($n,n,t)},emit:function(e,t,n){var r=De(e);Qn[r]?(Qn[r].emit(t,n),t===`destroy`&&delete Qn[r]):_.error("A monitor for `"+r+"` has not been initialized.")},updateData:function(e,t){var n=De(e);Qn[n]?Qn[n].emit(`hb`,t):_.error("A monitor for `"+n+"` has not been initialized.")},setEmitTranslator:function(e,t){var n=De(e);Qn[n]?Qn[n].emitTranslator=t:_.error("A monitor for `"+n+"` has not been initialized.")},setStateDataTranslator:function(e,t){var n=De(e);Qn[n]?Qn[n].stateDataTranslator=t:_.error("A monitor for `"+n+"` has not been initialized.")},setGetPlayheadTime:function(e,t){var n=De(e);Qn[n]?Qn[n].getPlayheadTime=t:_.error("A monitor for `"+n+"` has not been initialized.")},checkDoNotTrack:Pe,log:_,utils:qn,events:Jn,WINDOW_HIDDEN:!1,WINDOW_UNLOADING:!1};Object.assign($n,er),g!==void 0&&typeof g.addEventListener==`function`&&g.addEventListener(`pagehide`,function(e){e.persisted||($n.WINDOW_UNLOADING=!0)},!1);var tr=$n,b=n,x={VIDEO:`video`,THUMBNAIL:`thumbnail`,STORYBOARD:`storyboard`,DRM:`drm`},S={NOT_AN_ERROR:0,NETWORK_OFFLINE:2000002,NETWORK_RECONNECTING:2000003,NETWORK_UNKNOWN_ERROR:2e6,NETWORK_NO_STATUS:2000001,NETWORK_INVALID_URL:24e5,NETWORK_NOT_FOUND:2404e3,NETWORK_NOT_READY:2412e3,NETWORK_GENERIC_SERVER_FAIL:25e5,NETWORK_TOKEN_MISSING:2403201,NETWORK_TOKEN_MALFORMED:2412202,NETWORK_TOKEN_EXPIRED:2403210,NETWORK_TOKEN_AUD_MISSING:2403221,NETWORK_TOKEN_AUD_MISMATCH:2403222,NETWORK_TOKEN_SUB_MISMATCH:2403232,ENCRYPTED_ERROR:5e6,ENCRYPTED_UNSUPPORTED_KEY_SYSTEM:5000001,ENCRYPTED_GENERATE_REQUEST_FAILED:5000002,ENCRYPTED_UPDATE_LICENSE_FAILED:5000003,ENCRYPTED_UPDATE_SERVER_CERT_FAILED:5000004,ENCRYPTED_CDM_ERROR:5000005,ENCRYPTED_OUTPUT_RESTRICTED:5000006,ENCRYPTED_MISSING_TOKEN:5000002},nr=e=>e===x.VIDEO?`playback`:e,rr=class e extends Error{constructor(t,n=e.MEDIA_ERR_CUSTOM,r,i){super(t),this.name=`MediaError`,this.code=n,this.context=i,this.fatal=r??(n>=e.MEDIA_ERR_NETWORK&&n<=e.MEDIA_ERR_ENCRYPTED),this.message||=e.defaultMessages[this.code]??``}};rr.MEDIA_ERR_ABORTED=1,rr.MEDIA_ERR_NETWORK=2,rr.MEDIA_ERR_DECODE=3,rr.MEDIA_ERR_SRC_NOT_SUPPORTED=4,rr.MEDIA_ERR_ENCRYPTED=5,rr.MEDIA_ERR_CUSTOM=100,rr.defaultMessages={1:`You aborted the media playback`,2:`A network error caused the media download to fail.`,3:`A media error caused playback to be aborted. The media could be corrupt or your browser does not support this format.`,4:`An unsupported error occurred. The server or network failed, or your browser does not support this format.`,5:`The media is encrypted and there are no keys to decrypt it.`};var C=rr,ir=e=>e==null,ar=(e,t)=>!ir(t)&&e in t,or={ANY:`any`,MUTED:`muted`},w={ON_DEMAND:`on-demand`,LIVE:`live`,UNKNOWN:`unknown`},sr={MSE:`mse`,NATIVE:`native`},cr={HEADER:`header`,QUERY:`query`,NONE:`none`},lr=Object.values(cr),ur={M3U8:`application/vnd.apple.mpegurl`,MP4:`video/mp4`},dr={HLS:ur.M3U8};Object.keys(dr),[...Object.values(ur)];var fr={upTo720p:`720p`,upTo1080p:`1080p`,upTo1440p:`1440p`,upTo2160p:`2160p`},pr={noLessThan480p:`480p`,noLessThan540p:`540p`,noLessThan720p:`720p`,noLessThan1080p:`1080p`,noLessThan1440p:`1440p`,noLessThan2160p:`2160p`},mr={DESCENDING:`desc`},hr={code:`en`},gr=e=>{let t=e;for(;t;){if(t.hasAttribute(`lang`))return t.getAttribute(`lang`)||void 0;let e=t.getRootNode();t=e instanceof ShadowRoot?e.host:void 0}},_r=e=>{let t=globalThis.navigator?.languages??[globalThis.navigator?.language];return[gr(e),...t].filter(e=>!!e)},T=(e,t,n,r,i=e)=>{i.addEventListener(t,n,r),e.addEventListener(`teardown`,()=>{i.removeEventListener(t,n)},{once:!0})};function vr(e,t,n){t&&n>t&&(n=t);for(let t=0;t<e.length;t++)if(e.start(t)<=n&&e.end(t)>=n)return!0;return!1}var yr=e=>{let t=e.indexOf(`?`);return t<0?[e]:[e.slice(0,t),e.slice(t)]},br=e=>{let{type:t}=e;if(t){let e=t.toUpperCase();return ar(e,dr)?dr[e]:t}return Cr(e)},xr=e=>e===`VOD`?w.ON_DEMAND:w.LIVE,Sr=e=>e===`EVENT`?1/0:e===`VOD`?NaN:0,Cr=e=>{let{src:t}=e;if(!t)return``;let n=``;try{n=Er(t).pathname}catch{console.error(`Invalid url when trying to infer mime type`,t)}let r=n.lastIndexOf(`.`);if(r<0)return Or(e)?ur.M3U8:``;let i=n.slice(r+1).toUpperCase();return ar(i,ur)?ur[i]:``},wr=e=>{try{return new URL(e),!1}catch{return!0}},Tr=e=>e.split(`
`).find((e,t,n)=>t>0&&n[t-1].startsWith(`#EXT-X-STREAM-INF`)),Er=(e,t)=>{if(!wr(e))return new URL(e);let n=(window==null?void 0:window.location)?.href,r=t??n;return t&&wr(t.toString())&&(r=new URL(t,n)),new URL(e,r)},Dr=`mux.com`,Or=({src:e,customDomain:t=Dr})=>{let n;try{n=new URL(`${e}`)}catch{return!1}let r=n.protocol===`https:`,i=n.hostname===`stream.${t}`.toLowerCase(),a=n.pathname.split(`/`),o=a.length===2,s=!(a!=null&&a[1].includes(`.`));return r&&i&&o&&s},kr=e=>{let t=(e??``).split(`.`)[1];if(t)try{let e=t.replace(/-/g,`+`).replace(/_/g,`/`),n=decodeURIComponent(atob(e).split(``).map(function(e){return`%`+(`00`+e.charCodeAt(0).toString(16)).slice(-2)}).join(``));return JSON.parse(n)}catch{return}},Ar=({exp:e},t=Date.now())=>!e||e*1e3<t,jr=({sub:e},t)=>e!==t,Mr=({aud:e},t)=>!e,Nr=({aud:e},t)=>e!==t,Pr=`en`;function E(e,t=!0){var n;return new Fr(t&&(n=hr?.[e])!=null?n:e,t?hr.code:Pr)}var Fr=class{constructor(e,t=(e=>(e=hr)??Pr)()){this.message=e,this.locale=t}format(e){return this.message.replace(/\{(\w+)\}/g,(t,n)=>e[n]??``)}toString(){return this.message}},Ir=Object.values(or),Lr=e=>typeof e==`boolean`||typeof e==`string`&&Ir.includes(e),Rr=(e,t,n)=>{let{autoplay:r}=e,i=!1,a=!1,o=Lr(r)?r:!!r,s=()=>{i||T(t,`playing`,()=>{i=!0},{once:!0})};if(s(),T(t,`loadstart`,()=>{i=!1,s(),zr(t,o)},{once:!0}),T(t,`loadstart`,()=>{n||(a=e.streamType&&e.streamType!==w.UNKNOWN?e.streamType===w.LIVE:!Number.isFinite(t.duration)),zr(t,o)},{once:!0}),n&&n.once(b.Events.LEVEL_LOADED,(t,n)=>{a=e.streamType&&e.streamType!==w.UNKNOWN?e.streamType===w.LIVE:n.details.live??!1}),!o){let r=()=>{!a||Number.isFinite(e.startTime)||(n!=null&&n.liveSyncPosition?t.currentTime=n.liveSyncPosition:Number.isFinite(t.seekable.end(0))&&(t.currentTime=t.seekable.end(0)))};n&&T(t,`play`,()=>{t.preload===`metadata`?n.once(b.Events.LEVEL_UPDATED,r):r()},{once:!0})}return e=>{i||(o=Lr(e)?e:!!e,zr(t,o))}},zr=(e,t)=>{if(!t)return;let n=e.muted,r=()=>e.muted=n;switch(t){case or.ANY:e.play().catch(()=>{e.muted=!0,e.play().catch(r)});break;case or.MUTED:e.muted=!0,e.play().catch(r);break;default:e.play().catch(()=>{})}},Br=({preload:e,src:t},n,r)=>{let i=e=>{e!=null&&[``,`none`,`metadata`,`auto`].includes(e)?n.setAttribute(`preload`,e):n.removeAttribute(`preload`)};if(!r)return i(e),i;let a=!1,o=!1,s=r.config.maxBufferLength,c=r.config.maxBufferSize,l=e=>{i(e);let t=e??n.preload;o||t===`none`||(t===`metadata`?(r.config.maxBufferLength=1,r.config.maxBufferSize=1):(r.config.maxBufferLength=s,r.config.maxBufferSize=c),u())},u=()=>{!a&&t&&(a=!0,r.loadSource(t))};return T(n,`play`,()=>{o=!0,r.config.maxBufferLength=s,r.config.maxBufferSize=c,u()},{once:!0}),l(e),l},Vr=(e,t,n)=>{let{minPreloadSegments:r}=e;if(r==null||r<=0||!n)return;let i=0,a=!1,o=t.playbackRate||1,s=()=>{t.playbackRate!==0&&(o=t.playbackRate,t.playbackRate=0)};t.playbackRate=0,T(t,`ratechange`,s);let c=(e,{frag:n})=>{a||n.type!==`main`||(i++,i>=r&&(a=!0,t.removeEventListener(`ratechange`,s),t.playbackRate=o))};n.on(b.Events.FRAG_BUFFERED,c),t.addEventListener(`teardown`,()=>{a||(a=!0,n.off(b.Events.FRAG_BUFFERED,c),t.playbackRate=o)},{once:!0})},Hr=(e,t,n)=>{let{initialEstimateSegments:r}=e;if(r==null||r<=0||!n)return;let i=0;n.on(b.Events.FRAG_BUFFERED,(e,{frag:t})=>{t.type===`main`&&(i++,i<r&&n.abrController.resetEstimator(n.config.abrEwmaDefaultEstimate))})};function Ur(e,t){var n;if(!(`videoTracks`in e))return;let r=new WeakMap;t.on(b.Events.MANIFEST_PARSED,function(t,n){c();let i=e.addVideoTrack(`main`);i.selected=!0;for(let[e,t]of n.levels.entries()){let n=i.addRendition(t.url[0],t.width,t.height,t.videoCodec,t.bitrate);r.set(t,`${e}`),n.id=`${e}`}}),t.on(b.Events.AUDIO_TRACKS_UPDATED,function(t,n){s();for(let t of n.audioTracks){let n=t.default?`main`:`alternative`,r=e.addAudioTrack(n,t.name,t.lang);r.id=`${t.id}`,t.default&&(r.enabled=!0)}});let i=()=>{let n=+[...e.audioTracks].find(e=>e.enabled)?.id,r=t.audioTracks.map(e=>e.id);n!=t.audioTrack&&r.includes(n)&&(t.audioTrack=n)};e.audioTracks.addEventListener(`change`,i),t.on(b.Events.LEVELS_UPDATED,function(t,n){let i=e.videoTracks[e.videoTracks.selectedIndex??0];if(!i)return;let a=n.levels.map(e=>r.get(e));for(let t of e.videoRenditions)t.id&&!a.includes(t.id)&&i.removeRendition(t)});let a=e=>{let n=e.target.selectedIndex;n!=t.nextLevel&&(t.nextLevel=n)};(n=e.videoRenditions)==null||n.addEventListener(`change`,a);let o=()=>{for(let t of e.videoTracks)e.removeVideoTrack(t)},s=()=>{for(let t of e.audioTracks)e.removeAudioTrack(t)},c=()=>{o(),s()};t.once(b.Events.DESTROYING,()=>{var t,n;c(),(t=e.audioTracks)==null||t.removeEventListener(`change`,i),(n=e.videoRenditions)==null||n.removeEventListener(`change`,a)})}var Wr=e=>e.split(`-`)[0],Gr=({language:e})=>typeof e==`string`?e.toLowerCase():void 0;function Kr(e,t){let n=t.toLowerCase(),r=Wr(n);return e.find(e=>Gr(e)===n)??e.find(e=>Gr(e)===r)??e.find(e=>{let t=Gr(e);return t!==void 0&&Wr(t)===r})}function qr(e,t){let n=(Array.isArray(e)?e:[]).filter(e=>typeof e?.title==`string`&&e.title!==``);if(!n.length)return``;for(let e of t){let t=Kr(n,e);if(t)return t.title}return(n.find(e=>Gr(e)===`und`)??n[0]).title}function Jr(e,t=[]){return Array.isArray(e)?e.filter(e=>typeof e?.[`start-time`]==`number`).map((e,n,r)=>{let i=e[`start-time`],a=r[n+1]?.[`start-time`],o=typeof e.duration==`number`?i+e.duration:typeof a==`number`?a:void 0;return{startTime:i,...o==null?{}:{endTime:o},value:qr(e.titles,t)}}).filter(e=>e.value!==``):[]}var Yr=2**53-1,Xr=e=>`time`in e?e.time:e.startTime;function Zr(e,t){t.on(b.Events.NON_NATIVE_TEXT_TRACKS_FOUND,(n,{tracks:r})=>{r.forEach(n=>{let r=n.subtitleTrack??n.closedCaptions,i=t.subtitleTracks.findIndex(({lang:e,name:t,type:i})=>e==r?.lang&&t===n.label&&i.toLowerCase()===n.kind),a=n._id??n.default?`default`:`${n.kind}${i}`;Qr(e,n.kind,n.label,r?.lang,a,n.default)})});let n=()=>{if(!t.subtitleTracks.length)return;let n=Array.from(e.textTracks).find(e=>e.id&&e.mode===`showing`&&[`subtitles`,`captions`].includes(e.kind));if(!n)return;let r=t.subtitleTracks[t.subtitleTrack],i=r?r.default?`default`:`${t.subtitleTracks[t.subtitleTrack].type.toLowerCase()}${t.subtitleTrack}`:void 0;(t.subtitleTrack<0||n?.id!==i)&&(t.subtitleTrack=t.subtitleTracks.findIndex(({lang:e,name:t,type:r,default:i})=>n.id==="default"&&i||e==n.language&&t===n.label&&r.toLowerCase()===n.kind)),n?.id===i&&n.cues&&Array.from(n.cues).forEach(e=>{n.addCue(e)})};e.textTracks.addEventListener(`change`,n),t.on(b.Events.CUES_PARSED,(t,{track:n,cues:r})=>{let i=e.textTracks.getTrackById(n);if(!i)return;let a=i.mode===`disabled`;a&&(i.mode=`hidden`),r.forEach(e=>{var t;(t=i.cues)!=null&&t.getCueById(e.id)||i.addCue(e)}),a&&(i.mode=`disabled`)}),t.once(b.Events.DESTROYING,()=>{e.textTracks.removeEventListener(`change`,n),e.querySelectorAll(`track[data-removeondestroy]`).forEach(e=>{e.remove()})});let r=()=>{Array.from(e.textTracks).forEach(t=>{var n;if(![`subtitles`,`caption`].includes(t.kind)&&(t.label===`thumbnails`||t.kind===`chapters`)){if(!((n=t.cues)!=null&&n.length)){let n=`track`;t.kind&&(n+=`[kind="${t.kind}"]`),t.label&&(n+=`[label="${t.label}"]`);let r=e.querySelector(n),i=r?.getAttribute(`src`);r&&i&&(r.removeAttribute(`src`),setTimeout(()=>{r.setAttribute(`src`,i)},0))}t.mode!==`hidden`&&(t.mode=`hidden`)}})};t.once(b.Events.MANIFEST_LOADED,r),t.once(b.Events.MEDIA_ATTACHED,r)}function Qr(e,t,n,r,i,a){let o=document.createElement(`track`);return o.kind=t,o.label=n,r&&(o.srclang=r),i&&(o.id=i),a&&(o.default=!0),o.track.mode=[`subtitles`,`captions`].includes(t)?`disabled`:`hidden`,o.setAttribute(`data-removeondestroy`,``),e.append(o),o.track}function $r(e,t){Array.prototype.find.call(e.querySelectorAll(`track`),e=>e.track===t)?.remove()}function ei(e,t,n){return Array.from(e.querySelectorAll(`track`)).find(e=>e.track.label===t&&e.track.kind===n)?.track}var ti=new WeakMap;async function ni(e,t,n){let r=ei(e,t,n);if(r){let e=ti.get(r);return e&&await e,r}let i=Qr(e,n,t);i.mode=`hidden`;let a=new Promise(e=>setTimeout(e,0));return ti.set(i,a),await a,ti.delete(i),i}async function ri(e,t,n,r){let i=await ni(e,n,r);return ii(e,i,t,r),i}function ii(e,t,n,r){t.mode!==`hidden`&&(t.mode=`hidden`),[...n].sort((e,t)=>Xr(t)-Xr(e)).forEach(n=>{let i=n.value,a=Xr(n);if(`endTime`in n&&n.endTime!=null&&Number.isFinite(n.endTime))t?.addCue(new VTTCue(a,n.endTime,r===`chapters`?i:JSON.stringify(i??null)));else{let n=Array.prototype.findIndex.call(t?.cues,e=>e.startTime>=a),o=t?.cues?.[n],s=o?o.startTime:Number.isFinite(e.duration)&&e.duration>0?e.duration:Yr,c=t?.cues?.[n-1];c&&(c.endTime=a),t?.addCue(new VTTCue(a,s,r===`chapters`?i:JSON.stringify(i??null)))}}),e.textTracks.dispatchEvent(new Event(`change`,{bubbles:!0,composed:!0}))}var ai=`cuepoints`,oi=Object.freeze({label:ai});async function si(e,t,n=oi){return ri(e,t,n.label,`metadata`)}var ci=e=>({time:e.startTime,value:JSON.parse(e.text)});function li(e,t={label:ai}){let n=ei(e,t.label,`metadata`);return n!=null&&n.cues?Array.from(n.cues,e=>ci(e)):[]}function ui(e,t={label:ai}){var n;let r=ei(e,t.label,`metadata`);if(!((n=r?.activeCues)!=null&&n.length))return;if(r.activeCues.length===1)return ci(r.activeCues[0]);let{currentTime:i}=e;return ci(Array.prototype.find.call(r.activeCues??[],({startTime:e,endTime:t})=>e<=i&&t>i)||r.activeCues[0])}async function di(e,t=oi){return new Promise(n=>{T(e,`loadstart`,async()=>{let r=await si(e,[],t);T(e,`cuechange`,()=>{let t=ui(e);if(t){let n=new CustomEvent(`cuepointchange`,{composed:!0,bubbles:!0,detail:t});e.dispatchEvent(n)}},{},r),n(r)})})}var fi=`chapters`,pi=Object.freeze({label:fi}),mi=(e,t)=>{let{duration:n}=t,r=Number.isFinite(n)&&n>0?Math.min(e.endTime,n):e.endTime>=Yr?1/0:e.endTime;return{startTime:e.startTime,endTime:r,value:e.text}},hi=new WeakSet;function gi(e){Array.from(e.cues??[]).filter(e=>hi.has(e)).forEach(t=>e.removeCue(t))}async function _i(e,t,n=pi){let r=await ni(e,n.label,`chapters`);return t.length&&gi(r),ii(e,r,t,`chapters`),r}async function vi(e,t,n,r=pi){let i=await ni(e,r.label,`chapters`);return n!=null&&n.aborted||Array.from(i.cues??[]).some(e=>!hi.has(e))||(gi(i),ii(e,i,t,`chapters`),Array.from(i.cues??[]).forEach(e=>hi.add(e))),i}function yi(e,t={label:fi}){var n;let r=ei(e,t.label,`chapters`);return(n=r?.cues)!=null&&n.length?Array.from(r.cues,t=>mi(t,e)):[]}function bi(e,t={label:fi}){var n;let r=ei(e,t.label,`chapters`);if(!((n=r?.activeCues)!=null&&n.length))return;if(r.activeCues.length===1)return mi(r.activeCues[0],e);let{currentTime:i}=e;return mi(Array.prototype.find.call(r.activeCues??[],({startTime:e,endTime:t})=>e<=i&&t>i)||r.activeCues[0],e)}async function xi(e,t=pi){return new Promise(n=>{T(e,`loadstart`,async()=>{let r=await _i(e,[],t);T(e,`cuechange`,()=>{let t=bi(e);if(t){let n=new CustomEvent(`chapterchange`,{composed:!0,bubbles:!0,detail:t});e.dispatchEvent(n)}},{},r),n(r)})})}function Si(e,t){if(t){let n=t.playingDate;if(n!=null)return new Date(n.getTime()-e.currentTime*1e3)}return typeof e.getStartDate==`function`?e.getStartDate():new Date(NaN)}function Ci(e,t){if(t&&t.playingDate)return t.playingDate;if(typeof e.getStartDate==`function`){let t=e.getStartDate();return new Date(t.getTime()+e.currentTime*1e3)}return new Date(NaN)}var wi={VIDEO:`v`,THUMBNAIL:`t`,STORYBOARD:`s`,DRM:`d`},Ti=e=>{if(e===x.VIDEO)return wi.VIDEO;if(e===x.DRM)return wi.DRM},Ei=(e,t)=>{var n;let r=nr(e),i=`${r}Token`;return(n=t.tokens)!=null&&n[r]?t.tokens?.[r]:ar(i,t)?t[i]:void 0},Di=(e,t,n,r,i=!1,a=!(e=>(e=globalThis.navigator)?.onLine)())=>{if(a){let n=E(`Your device appears to be offline`,i),r=C.MEDIA_ERR_NETWORK,a=new C(n,r,!1,void 0);return a.errorCategory=t,a.muxCode=S.NETWORK_OFFLINE,a.data=e,a}let o=`status`in e?e.status:e.code,s=Date.now(),c=C.MEDIA_ERR_NETWORK;if(o===200)return;let l=nr(t),u=Ei(t,n),d=Ti(t),[f]=yr(n.playbackId??``);if(!o||!f)return;let p=kr(u);if(u&&!p){let n=new C(E(`The {tokenNamePrefix}-token provided is invalid or malformed.`,i).format({tokenNamePrefix:l}),c,!0,E(`Compact JWT string: {token}`,i).format({token:u}));return n.errorCategory=t,n.muxCode=S.NETWORK_TOKEN_MALFORMED,n.data=e,n}if(o>=500){let e=new C(``,c,r??!0);return e.errorCategory=t,e.muxCode=S.NETWORK_UNKNOWN_ERROR,e}if(o===403){if(p){if(Ar(p,s)){let n={timeStyle:`medium`,dateStyle:`medium`},r=E(`The video’s secured {tokenNamePrefix}-token has expired.`,i).format({tokenNamePrefix:l}),a=new Intl.DateTimeFormat(`en`,n).format(s),o=new C(r,c,!0,p.exp?E(`Expired at: {expiredDate}. Current time: {currentDate}.`,i).format({expiredDate:new Intl.DateTimeFormat(`en`,n).format(p.exp*1e3),currentDate:a}):E(`The {tokenNamePrefix}-token has no exp value. Current time: {currentDate}.`,i).format({tokenNamePrefix:l,currentDate:a}));return o.errorCategory=t,o.muxCode=S.NETWORK_TOKEN_EXPIRED,o.data=e,o}if(jr(p,f)){let n=new C(E(`The video’s playback ID does not match the one encoded in the {tokenNamePrefix}-token.`,i).format({tokenNamePrefix:l}),c,!0,E(`Specified playback ID: {playbackId} and the playback ID encoded in the {tokenNamePrefix}-token: {tokenPlaybackId}`,i).format({tokenNamePrefix:l,playbackId:f,tokenPlaybackId:p.sub}));return n.errorCategory=t,n.muxCode=S.NETWORK_TOKEN_SUB_MISMATCH,n.data=e,n}if(Mr(p,d)){let n=new C(E(`The {tokenNamePrefix}-token is formatted with incorrect information.`,i).format({tokenNamePrefix:l}),c,!0,E(`The {tokenNamePrefix}-token has no aud value. aud value should be {expectedAud}.`,i).format({tokenNamePrefix:l,expectedAud:d}));return n.errorCategory=t,n.muxCode=S.NETWORK_TOKEN_AUD_MISSING,n.data=e,n}if(Nr(p,d)){let n=new C(E(`The {tokenNamePrefix}-token is formatted with incorrect information.`,i).format({tokenNamePrefix:l}),c,!0,E(`The {tokenNamePrefix}-token has an incorrect aud value: {aud}. aud value should be {expectedAud}.`,i).format({tokenNamePrefix:l,expectedAud:d,aud:p.aud}));return n.errorCategory=t,n.muxCode=S.NETWORK_TOKEN_AUD_MISMATCH,n.data=e,n}}else{let n=E(`Authorization error trying to access this {category} URL. If this is a signed URL, you might need to provide a {tokenNamePrefix}-token.`,i).format({tokenNamePrefix:l,category:t}),a=E(`Specified playback ID: {playbackId}`,i).format({playbackId:f}),o=new C(n,c,r??!0,a);return o.errorCategory=t,o.muxCode=S.NETWORK_TOKEN_MISSING,o.data=e,o}}if(o===412){let a=E(`This playback-id may belong to a live stream that is not currently active or an asset that is not ready.`,i),o=E(`Specified playback ID: {playbackId}`,i).format({playbackId:f}),s=new C(a,c,r??!0,o);return s.errorCategory=t,s.muxCode=S.NETWORK_NOT_READY,s.streamType=n.streamType===w.LIVE?`live`:n.streamType===w.ON_DEMAND?`on-demand`:`unknown`,s.data=e,s}if(o===404){let n=E(`This URL or playback-id does not exist. You may have used an Asset ID or an ID from a different resource.`,i),a=E(`Specified playback ID: {playbackId}`,i).format({playbackId:f}),o=new C(n,c,r??!0,a);return o.errorCategory=t,o.muxCode=S.NETWORK_NOT_FOUND,o.data=e,o}if(o===400){let n=E(`The URL or playback-id was invalid. You may have used an invalid value as a playback-id.`),a=E(`Specified playback ID: {playbackId}`,i).format({playbackId:f}),o=new C(n,c,r??!0,a);return o.errorCategory=t,o.muxCode=S.NETWORK_INVALID_URL,o.data=e,o}let m=new C(``,c,r??!0);return m.errorCategory=t,m.muxCode=S.NETWORK_UNKNOWN_ERROR,m.data=e,m},Oi=b.DefaultConfig.capLevelController;Oi||console.error(`MinCapLevelController - hls.js DefaultConfig.capLevelController is unavailable`);var ki={"720p":921600,"1080p":2073600,"1440p":4194304,"2160p":8294400};function Ai(e){return ki[e.toLowerCase().trim()]}var ji=class e extends Oi{constructor(e){super(e)}static setMaxAutoResolution(t,n){n?e.maxAutoResolution.set(t,n):e.maxAutoResolution.delete(t)}getMaxAutoResolution(){let t=this.hls;return e.maxAutoResolution.get(t)??void 0}get levels(){return this.hls.levels??[]}getValidLevels(e){return this.levels.filter((t,n)=>this.isLevelAllowed(t)&&n<=e)}getMaxLevelCapped(e){let t=this.getValidLevels(e),n=this.getMaxAutoResolution();if(!n)return super.getMaxLevel(e);let r=Ai(n);if(!r)return super.getMaxLevel(e);let i=t.filter(e=>e.width*e.height<=r),a=i.findIndex(e=>e.width*e.height===r);if(a!==-1){let e=i[a];return t.findIndex(t=>t===e)}if(i.length===0)return 0;let o=i[i.length-1];return t.findIndex(e=>e===o)}getMaxLevel(t){if(this.getMaxAutoResolution()!==void 0)return this.getMaxLevelCapped(t);let n=super.getMaxLevel(t),r=this.getValidLevels(t);if(!r[n])return n;let i=Math.min(r[n].width,r[n].height),a=e.minMaxResolution;return i>=a?n:Oi.getMaxLevelByMediaSize(r,16/9*a,a)}};ji.minMaxResolution=720,ji.maxAutoResolution=new WeakMap;var Mi=ji,Ni=`com.apple.fps.1_0`,Pi=`application/vnd.apple.mpegurl`,Fi=({mediaEl:e,getAppCertificate:t,getLicenseKey:n,saveAndDispatchError:r,drmTypeCb:i})=>{if(!window.WebKitMediaKeys||!(`onwebkitneedkey`in e)){console.error(`No WebKitMediaKeys. FairPlay may not be supported`);let t=new C(E(`Cannot play DRM-protected content with current security configuration on this browser. Try playing in another browser.`),C.MEDIA_ERR_ENCRYPTED,!0);return t.errorCategory=x.DRM,t.muxCode=S.ENCRYPTED_CDM_ERROR,r(e,t),()=>{}}let a=e,o=t(),s=null,c=e=>{(async()=>{try{a.webkitKeys||l();let t=await o;if(e.initData===null||t==null)return;let n=Ii(e.initData,t);u(n)}catch(e){console.error(`Could not start encrypted playback due to exception`,e),r(a,e)}})()},l=()=>{try{let e=new WebKitMediaKeys(Ni);a.webkitSetMediaKeys(e),i()}catch{let e=new C(`Cannot play DRM-protected content with current security configuration on this browser. Try playing in another browser.`,C.MEDIA_ERR_ENCRYPTED,!0);throw e.errorCategory=x.DRM,e.muxCode=S.ENCRYPTED_UNSUPPORTED_KEY_SYSTEM,e}},u=t=>{let i=a.webkitKeys.createSession(Pi,t),o=async t=>{try{let e=t.message,r=await n(e);i.update(r)}catch(t){console.error(`Error on FairPlay session message`,t),r(e,t)}},c=t=>{let n=t.target.error;if(!n)return;console.error(`Internal Webkit Key Session Error - sysCode: ${n.systemCode} code: ${n.code}`);let i=new C(E(`The DRM Content Decryption Module system had an internal failure. Try reloading the page, updating your browser, or playing in another browser.`),C.MEDIA_ERR_ENCRYPTED,!0);i.errorCategory=x.DRM,i.muxCode=S.ENCRYPTED_CDM_ERROR,r(e,i)},l=()=>{i.removeEventListener(`webkitkeymessage`,o),i.removeEventListener(`webkitkeyerror`,c),e.removeEventListener(`teardown`,l),`webkitCurrentPlaybackTargetIsWireless`in e&&e.removeEventListener(`webkitcurrentplaybacktargetiswirelesschanged`,l),s=null;try{i.close()}catch{}};`webkitCurrentPlaybackTargetIsWireless`in e&&e.addEventListener(`webkitcurrentplaybacktargetiswirelesschanged`,l,{once:!0}),i.addEventListener(`webkitkeymessage`,o),i.addEventListener(`webkitkeyerror`,c),e.addEventListener(`teardown`,l),s=l},d=()=>{e.removeEventListener(`webkitneedkey`,c),e.removeEventListener(`teardown`,d),s?.();try{a.webkitSetMediaKeys(null)}catch{}};return e.addEventListener(`webkitneedkey`,c),e.addEventListener(`teardown`,d,{once:!0}),d},Ii=(e,t)=>{let n=Ri(Li(e)),r=new Uint8Array(e),i=new Uint8Array(n),a=new Uint8Array(t),o=r.byteLength+4+a.byteLength+4+i.byteLength,s=new Uint8Array(o),c=0,l=e=>{s.set(e,c),c+=e.byteLength},u=e=>{let t=new DataView(s.buffer),n=e.byteLength;t.setUint32(c,n,!0),c+=4,l(e)};return l(r),u(i),u(a),s},Li=e=>new TextDecoder(`utf-16le`).decode(e).replace(`skd://`,``).slice(1);function Ri(e){let t=new ArrayBuffer(e.length*2),n=new DataView(t);for(let t=0;t<e.length;t++)n.setUint16(t*2,e.charCodeAt(t),!0);return t}var zi=({mediaEl:e,getAppCertificate:t,getLicenseKey:n,saveAndDispatchError:r,drmTypeCb:i,fallbackToWebkitFairplay:a})=>{let o=null,s=async t=>{try{let n=t.initDataType;if(n!==`skd`){console.error(`Received unexpected initialization data type "${n}"`);return}e.mediaKeys||await c(n);let r=t.initData;if(r==null){console.error(`Could not start encrypted playback due to missing initData in ${t.type} event`);return}await l(n,r)}catch(t){r(e,t);return}},c=async n=>{let a=await navigator.requestMediaKeySystemAccess(`com.apple.fps`,[{initDataTypes:[n],videoCapabilities:[{contentType:`application/vnd.apple.mpegurl`,robustness:``}],distinctiveIdentifier:`not-allowed`,persistentState:`not-allowed`,sessionTypes:[`temporary`]}]).then(e=>(i(),e)).catch(()=>{let t=new C(E(`Cannot play DRM-protected content with current security configuration on this browser. Try playing in another browser.`),C.MEDIA_ERR_ENCRYPTED,!0);t.errorCategory=x.DRM,t.muxCode=S.ENCRYPTED_UNSUPPORTED_KEY_SYSTEM,r(e,t)});if(!a)return;let o=await a.createMediaKeys();try{let e=await t();await o.setServerCertificate(e).catch(()=>{let e=new C(E(`Your server certificate failed when attempting to set it. This may be an issue with a no longer valid certificate.`),C.MEDIA_ERR_ENCRYPTED,!0);return e.errorCategory=x.DRM,e.muxCode=S.ENCRYPTED_UPDATE_SERVER_CERT_FAILED,Promise.reject(e)})}catch(t){r(e,t);return}await e.setMediaKeys(o)},l=async(t,i)=>{let s=e.mediaKeys.createSession(),c=async t=>{let i=t.message,a=await n(i);try{await s.update(a)}catch{let t=new C(E(`Failed to update DRM license. This may be an issue with the player or your protected content.`),C.MEDIA_ERR_ENCRYPTED,!0);t.errorCategory=x.DRM,t.muxCode=S.ENCRYPTED_UPDATE_LICENSE_FAILED,r(e,t)}},l=()=>{let t=t=>{let n;t===`internal-error`?(n=new C(E(`The DRM Content Decryption Module system had an internal failure. Try reloading the page, updating your browser, or playing in another browser.`),C.MEDIA_ERR_ENCRYPTED,!0),n.errorCategory=x.DRM,n.muxCode=S.ENCRYPTED_CDM_ERROR):(t===`output-restricted`||t===`output-downscaled`)&&(n=new C(E(`DRM playback is being attempted in an environment that is not sufficiently secure. User may see black screen.`),C.MEDIA_ERR_ENCRYPTED,!1),n.errorCategory=x.DRM,n.muxCode=S.ENCRYPTED_OUTPUT_RESTRICTED),n&&r(e,n)};s.keyStatuses.forEach(e=>t(e))};s.addEventListener(`keystatuseschange`,l),s.addEventListener(`message`,c);let u=async()=>{s.removeEventListener(`keystatuseschange`,l),s.removeEventListener(`message`,c),`webkitCurrentPlaybackTargetIsWireless`in e&&e.removeEventListener(`webkitcurrentplaybacktargetiswirelesschanged`,u),e.removeEventListener(`teardown`,u),await s.close().catch(e=>{console.warn(`There was an error when closing EME session`,e)}),o=null};`webkitCurrentPlaybackTargetIsWireless`in e&&e.addEventListener(`webkitcurrentplaybacktargetiswirelesschanged`,u,{once:!0}),e.addEventListener(`teardown`,u,{once:!0}),o=u,await s.generateRequest(t,i).catch(async t=>{if(t.name===`NotSupportedError`&&`webkitCurrentPlaybackTargetIsWireless`in e&&e.webkitCurrentPlaybackTargetIsWireless)console.warn(`Failed to generate a DRM license request. Attempting to fallback to Webkit DRM`),a?.();else{let e=new C(E(`Failed to generate a DRM license request. This may be an issue with the player or your protected content.`),C.MEDIA_ERR_ENCRYPTED,!0);return e.errorCategory=x.DRM,e.muxCode=S.ENCRYPTED_GENERATE_REQUEST_FAILED,console.error(`Failed to generate license request`,t),Promise.reject(e)}})},u=async()=>{e.removeEventListener(`encrypted`,s),e.removeEventListener(`teardown`,u),o&&await o(),await e.setMediaKeys(null).catch(()=>{})};return e.addEventListener(`encrypted`,s),e.addEventListener(`teardown`,u,{once:!0}),u},Bi=({hls:e,mediaEl:t,src:n,muxMediaState:r,saveAndDispatchError:i,maxRetries:a})=>{var o;let s,c=0,l=!1,u=!1,d=!1,f=()=>{s!=null&&(clearTimeout(s),s=void 0)},p=e=>e?.muxCode===S.NETWORK_RECONNECTING,m=()=>!t.paused&&t.readyState<HTMLMediaElement.HAVE_FUTURE_DATA,h=()=>{let e=r.get(t);if(p(e?.error))return;let n=new C(E(`Attempting to reconnect...`),C.MEDIA_ERR_NETWORK,!1);n.errorCategory=x.VIDEO,n.muxCode=S.NETWORK_RECONNECTING,e&&(e.error=n),t.dispatchEvent(new CustomEvent(`error`,{detail:n}))},ee=()=>{!d&&n?e.loadSource(n):e.startLoad(t.currentTime)},te=()=>{l=!1,u=!0,f();let e=new C(E(`Network error, try reloading.`),C.MEDIA_ERR_NETWORK,!0);e.errorCategory=x.VIDEO,e.reload=!0,i(t,e)},ne=()=>{if(s!=null||l)return;if(c>=a){te();return}l=!0;let e=Math.min(1e3*2**c,3e4);s=setTimeout(()=>{s=void 0,c+=1,ee()},e)},re=()=>{let e=r.get(t);!(e!=null&&e.networkError)||u||m()&&(h(),ne())},ie=()=>{let e=r.get(t);e&&(e.networkError=!0),l=!1,re()},ae=()=>{let e=r.get(t);e!=null&&e.networkError&&(c=0,u=!1,f(),l=!0,ee())};return(o=globalThis.addEventListener)==null||o.call(globalThis,`online`,ae),e.on(b.Events.FRAG_BUFFERED,()=>{let e=r.get(t);e&&(!e.networkError&&!p(e.error)||(e.networkError=!1,l=!1,c=0,u=!1,f(),e.error&&(e.error=null,t.dispatchEvent(new Event(`emptied`)))))}),T(t,`playing`,()=>{let e=r.get(t);e!=null&&e.networkError&&(l=!1,c=0,u=!1,f(),e.error&&=null)}),T(t,`waiting`,re),t.addEventListener(`teardown`,()=>{var e;(e=globalThis.removeEventListener)==null||e.call(globalThis,`online`,ae),f()},{once:!0}),{handleHlsError:(e,t)=>{if(e.type!==b.ErrorTypes.NETWORK_ERROR)return!1;let n=e.response?.code??0;return(t.muxCode===S.NETWORK_OFFLINE||n===0||n>=500)&&e.fatal?(ie(),!0):!1},onManifestLoaded:()=>{d=!0,l=!1,f()}}},Vi={FAIRPLAY:`fairplay`,PLAYREADY:`playready`,WIDEVINE:`widevine`},Hi=e=>{if(e.includes(`fps`))return Vi.FAIRPLAY;if(e.includes(`playready`))return Vi.PLAYREADY;if(e.includes(`widevine`))return Vi.WIDEVINE},Ui=(e,t,n)=>{let r=Tr(e);if(!r)return Promise.reject(Error(`No media playlist URL found in multivariant playlist`));if(wr(r)&&!t)return Promise.reject(Error(`masterPlaylistUrl is required to resolve relative media playlist URL`));let i;try{i=Er(r,t)}catch(e){return Promise.reject(e)}return fetch(i,{signal:n}).then(e=>e.status===200?e.text():Promise.reject(e))},Wi=e=>{let t=e.split(`
`).filter(e=>e.startsWith(`#EXT-X-SESSION-DATA`));if(!t.length)return{};let n={};for(let e of t){let t=Ki(e),r=t[`DATA-ID`];r&&(n[r]={...t})}return{sessionData:n}},Gi=/([A-Z0-9-]+)="?(.*?)"?(?:,|$)/g;function Ki(e){let t=[...e.matchAll(Gi)];return Object.fromEntries(t.map(([,e,t])=>[e,t]))}var qi=e=>{let t=e.split(`
`),n=(t.find(e=>e.startsWith(`#EXT-X-PLAYLIST-TYPE`))??``).split(`:`)[1]?.trim(),r=xr(n),i=Sr(n),a;if(r===w.LIVE){let e=t.find(e=>e.startsWith(`#EXT-X-PART-INF`));a=e?e.split(`:`)[1].split(`=`)[1]*2:(t.find(e=>e.startsWith(`#EXT-X-TARGETDURATION`))?.split(`:`)?.[1]??6)*3}return{streamType:r,targetLiveWindow:i,liveEdgeStartOffset:a}},Ji=async(e,t,n)=>{if(t===ur.MP4)return{streamType:w.ON_DEMAND,targetLiveWindow:NaN,liveEdgeStartOffset:void 0,sessionData:void 0,playlistUrl:void 0};if(t===ur.M3U8){let t=await fetch(e,{signal:n});if(!t.ok)return Promise.reject(t);let r=await t.text(),i=t.url||e,a=await Ui(r,i,n);return{...Wi(r),...qi(a),playlistUrl:i}}return console.error(`Media type ${t} is an unrecognized or unsupported type for src ${e}.`),{streamType:void 0,targetLiveWindow:void 0,liveEdgeStartOffset:void 0,sessionData:void 0,playlistUrl:void 0}},Yi=async(e,t,n=br({src:e}),r=Zi(t))=>{let{streamType:i,targetLiveWindow:a,liveEdgeStartOffset:o,sessionData:s,playlistUrl:c}=await Ji(e,n,r);if(r.aborted)return;let l=Xi(s?.[`com.apple.hls.chapters`],c??e);l&&ta(l,t,r),(D.get(t)??{}).liveEdgeStartOffset=o,(D.get(t)??{}).targetLiveWindow=a,t.dispatchEvent(new CustomEvent(`targetlivewindowchange`,{composed:!0,bubbles:!0})),(D.get(t)??{}).streamType=i,t.dispatchEvent(new CustomEvent(`streamtypechange`,{composed:!0,bubbles:!0}))},Xi=(e,t)=>{var n;let r=e?.URI||((n=e?.VALUE)!=null&&n.toLocaleLowerCase().startsWith(`http`)?e.VALUE:void 0);if(r)try{return Er(r,t).toString()}catch{return}},Zi=e=>{let t=new AbortController;return e.addEventListener(`teardown`,()=>t.abort(),{once:!0}),t.signal},Qi=async(e,t)=>{try{let n=await fetch(e,{signal:t});if(!n.ok)throw Error(`Failed to fetch ${e}: ${n.status} ${n.statusText}`);let r=await n.json();return t.aborted?void 0:r}catch(e){t.aborted||console.error(e);return}},$i=(e,t)=>{if(!Array.isArray(e?.[0]?.metadata))return;let n={};for(let t of e[0].metadata)t!=null&&t.key&&t!=null&&t.value&&(n[t.key]=t.value);(D.get(t)??{}).metadata=n;let r=new CustomEvent(`muxmetadata`);t.dispatchEvent(r)},ea=async(e,t,n=Zi(t))=>{let r=await Qi(e,n);r!==void 0&&$i(r,t)},ta=async(e,t,n=Zi(t))=>{let r=await Qi(e,n);r!==void 0&&($i(r,t),await vi(t,Jr(r,_r(t)),n))},na=e=>{var t;let n=e.type,r=xr(n),i=Sr(n),a,o=!!((t=e.partList)!=null&&t.length);return r===w.LIVE&&(a=o?e.partTarget*2:e.targetduration*3),{streamType:r,targetLiveWindow:i,liveEdgeStartOffset:a,lowLatency:o}},ra=(e,t,n)=>{let{streamType:r,targetLiveWindow:i,liveEdgeStartOffset:a,lowLatency:o}=na(e);if(r===w.LIVE){o?(n.config.backBufferLength=n.userConfig.backBufferLength??4,n.config.maxFragLookUpTolerance=n.userConfig.maxFragLookUpTolerance??.001,n.config.abrBandWidthUpFactor=n.userConfig.abrBandWidthUpFactor??n.config.abrBandWidthFactor):n.config.backBufferLength=n.userConfig.backBufferLength??8;let e=Object.freeze({get length(){return t.seekable.length},start(e){return t.seekable.start(e)},end(e){return e>this.length||e<0||Number.isFinite(t.duration)?t.seekable.end(e):n.liveSyncPosition??t.seekable.end(e)}});(D.get(t)??{}).seekable=e}(D.get(t)??{}).liveEdgeStartOffset=a,(D.get(t)??{}).targetLiveWindow=i,t.dispatchEvent(new CustomEvent(`targetlivewindowchange`,{composed:!0,bubbles:!0})),(D.get(t)??{}).streamType=r,t.dispatchEvent(new CustomEvent(`streamtypechange`,{composed:!0,bubbles:!0}))},ia=(globalThis==null?void 0:globalThis.navigator)?.userAgent??``,aa=(globalThis==null?void 0:globalThis.navigator)?.userAgentData?.platform??``,oa=ia.toLowerCase().includes(`android`)||[`x11`,`android`].some(e=>aa.toLowerCase().includes(e)),sa=e=>/^((?!chrome|android).)*safari/i.test(ia)&&!!e.canPlayType(`application/vnd.apple.mpegurl`),D=new WeakMap,ca=`mux.com`,la,ua=(la=b).isSupported?.call(la),da=e=>oa||!sa(e),fa=()=>{if(typeof window<`u`)return tr.utils.now()},pa=tr.utils.generateUUID,ma=({playbackId:e,customDomain:t=ca,maxResolution:n,minResolution:r,renditionOrder:i,programStartTime:a,programEndTime:o,assetStartTime:s,assetEndTime:c,playbackToken:l,tokens:{playback:u=l}={},extraSourceParams:d={}}={})=>{if(!e)return;let[f,p=``]=yr(e),m=new URL(`https://stream.${t}/${f}.m3u8${p}`);return u||m.searchParams.has(`token`)?(m.searchParams.forEach((e,t)=>{t!=`token`&&m.searchParams.delete(t)}),u&&m.searchParams.set(`token`,u)):(n&&m.searchParams.set(`max_resolution`,n),r&&(m.searchParams.set(`min_resolution`,r),n&&+n.slice(0,-1)<+r.slice(0,-1)&&console.error(`minResolution must be <= maxResolution`,`minResolution`,r,`maxResolution`,n)),i&&m.searchParams.set(`rendition_order`,i),a&&m.searchParams.set(`program_start_time`,`${a}`),o&&m.searchParams.set(`program_end_time`,`${o}`),s&&m.searchParams.set(`asset_start_time`,`${s}`),c&&m.searchParams.set(`asset_end_time`,`${c}`),Object.entries(d).forEach(([e,t])=>{t!=null&&m.searchParams.set(e,t)})),m.toString()},ha=e=>{if(!e)return;let[t]=e.split(`?`);return t||void 0},ga=e=>{if(!e||!e.startsWith(`https://stream.`))return;let[t]=new URL(e).pathname.slice(1).split(/\.m3u8|\//);return t||void 0},_a=e=>{var t,n;return(t=e?.metadata)!=null&&t.video_id?e.metadata.video_id:Ka(e)&&(n=ha(e.playbackId)??ga(e.src))!=null?n:e.src},va=e=>D.get(e)?.error,ya=e=>D.get(e)?.metadata,ba=e=>D.get(e)?.streamType??w.UNKNOWN,xa=e=>D.get(e)?.targetLiveWindow??NaN,Sa=e=>D.get(e)?.seekable??e.seekable,Ca=e=>{let t=D.get(e)?.liveEdgeStartOffset;if(typeof t!=`number`)return NaN;let n=Sa(e);return n.length?n.end(n.length-1)-t:NaN},wa=e=>D.get(e)?.coreReference,Ta=.034,Ea=(e,t,n=Ta)=>Math.abs(e-t)<=n,Da=(e,t,n=Ta)=>e>t||Ea(e,t,n),Oa=(e,t=Ta)=>e.paused&&Da(e.currentTime,e.duration,t),ka=(e,t)=>{if(!t||!e.buffered.length)return;if(e.readyState>2)return!1;let n=t.currentLevel>=0?t.levels?.[t.currentLevel]?.details:t.levels.find(e=>!!e.details)?.details;if(!n||n.live)return;let{fragments:r}=n;if(!(r!=null&&r.length))return;if(e.currentTime<e.duration-(n.targetduration+.5))return!1;let i=r[r.length-1];if(e.currentTime<=i.start)return!1;let a=i.start+i.duration/2,o=e.buffered.start(e.buffered.length-1),s=e.buffered.end(e.buffered.length-1);return a>o&&a<s},Aa=(e,t)=>e.ended||e.loop?e.ended:t&&ka(e,t)?!0:Oa(e),ja=(e,t,n)=>{Ia(t,n,e);let{metadata:r={}}=e,{view_session_id:i=pa()}=r,a=_a(e);r.view_session_id=i,r.video_id=a,e.metadata=r,e.drmTypeCb=e=>{var n;(n=t.mux)==null||n.emit(`hb`,{view_drm_type:e})},e.fallbackToWebkitFairplay=async()=>{let n=!t.paused,r=t.currentTime;e.useWebkitFairplay=!0;let i=e.muxDataKeepSession;e.muxDataKeepSession=!0,ja(e,t,D.get(t)?.coreReference),e.muxDataKeepSession=i,e.useWebkitFairplay=!1,n&&await t.play().then(()=>{t.currentTime=r}).catch(()=>{}),t.currentTime=r},D.set(t,{retryCount:0});let o=Ra(e,t),s=Br(e,t,o);e!=null&&e.muxDataKeepSession&&t!=null&&t.mux&&!t.mux.deleted?o&&t.mux.addHLSJS({hlsjs:o,Hls:o?b:void 0}):Ja(e,t,o),Ya(e,t,o),di(t),xi(t);let c=Rr(e,t,o);Vr(e,t,o),Hr(e,t,o);let l={engine:o,setAutoplay:c,setPreload:s},u=D.get(t);return u&&(u.coreReference=l),l},Ma=()=>{let e=new Date(0).toUTCString(),t=new Set([`muxData`]);document.cookie.split(`;`).forEach(e=>{let n=e.split(`=`)[0].trim();n.startsWith(`muxData`)&&t.add(n)}),t.forEach(t=>{document.cookie=`${t}=;expires=${e};path=/`})},Na=new WeakMap,Pa=(e,t,n)=>{t&&(t.mux&&(t.mux.deleted||t.mux.destroy(),delete t.mux),!Na.has(t)&&Na.set(t,Promise.resolve().then(()=>{Na.delete(t);let r=D.get(t);!r||t.mux&&!t.mux.deleted||Ja(e,t,(r.coreReference??n)?.engine)})))},Fa=(e,t,n)=>{if(!t)return;let r=!!e.disableCookies,i=D.get(t);!i||i.muxDataDisableCookies===r||(Pa(e,t,n),r&&Promise.resolve().then(()=>{e.disableCookies&&Ma()}))},Ia=(e,t,n)=>{let r=t?.engine;e!=null&&e.mux&&!e.mux.deleted&&(n!=null&&n.muxDataKeepSession?r&&e.mux.removeHLSJS():(e.mux.destroy(),delete e.mux)),r&&(r.detachMedia(),r.destroy()),e&&(e.hasAttribute(`src`)&&(e.removeAttribute(`src`),e.load()),e.removeEventListener(`error`,Za),e.removeEventListener(`error`,$a),e.removeEventListener(`durationchange`,Xa),D.delete(e),e.dispatchEvent(new Event(`teardown`)))};function La(e,t){let n=br(e);if(n!==ur.M3U8)return!0;let r=!n||(t.canPlayType(n)??!0),{preferPlayback:i}=e,a=i===sr.MSE,o=i===sr.NATIVE,s=ua&&(a||da(t));return r&&(o||!s)}var Ra=(e,t)=>{let{debug:n,streamType:r,startTime:i=-1,metadata:a,preferCmcd:o,_hlsConfig:s={},maxAutoResolution:c,initialBandwidthEstimateKbps:l}=e,u=br(e)===ur.M3U8,d=La(e,t);if(u&&!d&&ua){let u={backBufferLength:30,renderTextTracksNatively:!1,liveDurationInfinity:!0,capLevelOnFPSDrop:!0,...l==null?{}:{abrEwmaDefaultEstimate:l*1e3}},d=za(r),f=Ba(e),p=[cr.QUERY,cr.HEADER].includes(o)?{useHeaders:o===cr.HEADER,sessionId:a?.view_session_id,contentId:a?.video_id}:void 0,m=qa(e,s),h=new b({debug:n,startPosition:i,cmcd:p,xhrSetup:(e,t)=>{if(o&&o!==cr.QUERY)return;let n=Er(t);if(!n.searchParams.has(`CMCD`))return;let r=(n.searchParams.get(`CMCD`)?.split(`,`)??[]).filter(e=>e.startsWith(`sid`)||e.startsWith(`cid`)).join(`,`);n.searchParams.set(`CMCD`,r),e.open(`GET`,n)},...u,...m,...d,...f,...s});return m.capLevelController===Mi&&c!==void 0&&Mi.setMaxAutoResolution(h,c),h.on(b.Events.MANIFEST_LOADED,async function(e,n){let r=Xi(n.sessionData?.[`com.apple.hls.chapters`],n.url);r&&ta(r,t)}),h}},za=e=>e===w.LIVE?{backBufferLength:8}:{},Ba=e=>{let{tokens:{drm:t}={},playbackId:n,drmTypeCb:r}=e,i=ha(n);return!t||!i?{}:{emeEnabled:!0,drmSystems:{"com.apple.fps":{licenseUrl:Wa(e,`fairplay`),serverCertificateUrl:Ga(e,`fairplay`)},"com.widevine.alpha":{licenseUrl:Wa(e,`widevine`)},"com.microsoft.playready":{licenseUrl:Wa(e,`playready`)}},requestMediaKeySystemAccessFunc:(e,t)=>(e===`com.widevine.alpha`&&(t=[...t.map(e=>{let t=e.videoCapabilities?.map(e=>({...e,robustness:`HW_SECURE_ALL`}));return{...e,videoCapabilities:t}}),...t]),navigator.requestMediaKeySystemAccess(e,t).then(t=>{let n=Hi(e);return r?.(n),t}))}},Va=async e=>{let t=await fetch(e);return t.status===200?await t.arrayBuffer():Promise.reject(t)},Ha=async(e,t)=>{let n=await fetch(t,{method:`POST`,headers:{"Content-type":`application/octet-stream`},body:e});if(n.status!==200)return Promise.reject(n);let r=await n.arrayBuffer();return new Uint8Array(r)},Ua=(e,t)=>{let n={mediaEl:t,getAppCertificate:()=>Va(Ga(e,`fairplay`)).catch(t=>{if(t instanceof Response){let n=Di(t,x.DRM,e);return console.error(`mediaError`,n?.message,n?.context),n?Promise.reject(n):Promise.reject(Error(`Unexpected error in app cert request`))}return Promise.reject(t)}),getLicenseKey:t=>Ha(t,Wa(e,`fairplay`)).catch(t=>{if(t instanceof Response){let n=Di(t,x.DRM,e);return console.error(`mediaError`,n?.message,n?.context),n?Promise.reject(n):Promise.reject(Error(`Unexpected error in license key request`))}return Promise.reject(t)}),saveAndDispatchError:Qa,drmTypeCb:()=>{var t;(t=e.drmTypeCb)==null||t.call(e,Vi.FAIRPLAY)}};if(e.useWebkitFairplay)Fi(n);else{let t=zi({fallbackToWebkitFairplay:async()=>{var n;await t(),(n=e.fallbackToWebkitFairplay)==null||n.call(e)},...n})}},Wa=({playbackId:e,tokens:{drm:t}={},customDomain:n=ca},r)=>{let i=ha(e);return`https://license.${n.toLocaleLowerCase().endsWith(ca)?n:ca}/license/${r}/${i}?token=${t}`},Ga=({playbackId:e,tokens:{drm:t}={},customDomain:n=ca},r)=>{let i=ha(e);return`https://license.${n.toLocaleLowerCase().endsWith(ca)?n:ca}/appcert/${r}/${i}?token=${t}`},Ka=({playbackId:e,src:t,customDomain:n})=>{if(e)return!0;if(typeof t!=`string`)return!1;let r=window==null?void 0:window.location.href,i=new URL(t,r).hostname.toLocaleLowerCase();return i.includes(ca)||!!n&&i.includes(n.toLocaleLowerCase())},qa=(e,t)=>{let n={};return n.capLevelToPlayerSize=e.capRenditionToPlayerSize,n.capLevelToPlayerSize==null?(n.capLevelController=Mi,n.capLevelToPlayerSize=!0):n.capLevelController=r,n},Ja=(e,t,n)=>{let{envKey:r,disableTracking:i,muxDataSDK:a=tr,muxDataSDKOptions:o={}}=e,s=Ka(e),c=D.get(t);if(c&&(c.muxDataDisableCookies=!!e.disableCookies),!i&&(r||s)){let{playerInitTime:i,playerSoftwareName:s,playerSoftwareVersion:c,beaconCollectionDomain:l,debug:u,disableCookies:d}=e,f={...e.metadata,video_title:e?.metadata?.video_title||void 0};a.monitor(t,{debug:u,beaconCollectionDomain:l,hlsjs:n,Hls:n?b:void 0,automaticErrorTracking:!1,errorTranslator:t=>typeof t.player_error_code==`string`?!1:typeof e.errorTranslator==`function`?e.errorTranslator(t):t,disableCookies:d,...o,data:{...r?{env_key:r}:{},player_software_name:s,player_software:s,player_software_version:c,player_init_time:i,...f}})}},Ya=(e,t,n)=>{var r;let i=La(e,t),{src:a,customDomain:o=ca}=e,s=()=>{t.ended||e.disablePseudoEnded||!Aa(t,n)||(ka(t,n)?t.currentTime=t.buffered.end(t.buffered.length-1):t.dispatchEvent(new Event(`ended`)))},c,l,u=()=>{let e=Sa(t),n,r;e.length>0&&(n=e.start(0),r=e.end(0)),(l!==r||c!==n)&&t.dispatchEvent(new CustomEvent(`seekablechange`,{composed:!0})),c=n,l=r};if(T(t,`durationchange`,u),t&&i){let n=br(e);if(typeof a==`string`){if(a.endsWith(`.mp4`)&&a.includes(o)){let e=ga(a);ea(new URL(`https://stream.${o}/${e}/metadata.json`).toString(),t)}let i=()=>{if(ba(t)!==w.LIVE||Number.isFinite(t.duration))return;let e=setInterval(u,1e3);t.addEventListener(`teardown`,()=>{clearInterval(e)},{once:!0}),T(t,`durationchange`,()=>{Number.isFinite(t.duration)&&clearInterval(e)})},s=async()=>{let r=Zi(t);return Yi(a,t,n,r).then(()=>{r.aborted||i()}).catch(n=>{if(n instanceof Response){let r=Di(n,x.VIDEO,e);if(r){Qa(t,r);return}}else n instanceof Error})};if(t.preload===`none`){let e=()=>{s(),t.removeEventListener(`loadedmetadata`,n)},n=()=>{s(),t.removeEventListener(`play`,e)};T(t,`play`,e,{once:!0}),T(t,`loadedmetadata`,n,{once:!0})}else s();(r=e.tokens)!=null&&r.drm?Ua(e,t):T(t,`encrypted`,()=>{let e=new C(E(`Attempting to play DRM-protected content without providing a DRM token.`),C.MEDIA_ERR_ENCRYPTED,!0);e.errorCategory=x.DRM,e.muxCode=S.ENCRYPTED_MISSING_TOKEN,Qa(t,e)},{once:!0}),t.setAttribute(`src`,a),e.startTime&&((D.get(t)??{}).startTime=e.startTime,t.addEventListener(`durationchange`,Xa,{once:!0}))}else t.removeAttribute(`src`);t.addEventListener(`error`,Za),t.addEventListener(`error`,$a),t.addEventListener(`emptied`,()=>{t.querySelectorAll(`track[data-removeondestroy]`).forEach(e=>{e.remove()})},{once:!0}),T(t,`pause`,s),T(t,`seeked`,s),T(t,`play`,()=>{t.ended||Da(t.currentTime,t.duration)&&(t.currentTime=t.seekable.length?t.seekable.start(0):0)})}else if(n&&a){n.once(b.Events.LEVEL_LOADED,(e,r)=>{ra(r.details,t,n),u(),ba(t)===w.LIVE&&!Number.isFinite(t.duration)&&(n.on(b.Events.LEVEL_UPDATED,u),T(t,`durationchange`,()=>{Number.isFinite(t.duration)&&n.off(b.Events.LEVELS_UPDATED,u)}))});let r=e.maxReconnectRetries??0,i=r>0?Bi({hls:n,mediaEl:t,src:a,muxMediaState:D,saveAndDispatchError:Qa,maxRetries:r}):void 0;n.on(b.Events.ERROR,(r,a)=>{let o=eo(a,e);if(o.muxCode===S.NETWORK_NOT_READY){let e=D.get(t)??{},r=e.retryCount??0;if(r<6){let i=r===0?5e3:6e4,s=new C(`Retrying in ${i/1e3} seconds...`,o.code,o.fatal);Object.assign(s,o),Qa(t,s);let c=setTimeout(()=>{e.retryCount=r+1,a.details===`manifestLoadError`&&a.url&&n.loadSource(a.url)},i);t.addEventListener(`teardown`,()=>clearTimeout(c),{once:!0});return}{e.retryCount=0;let n=new C(`Network error, try reloading.`,o.code,o.fatal);Object.assign(n,o),n.reload=!0,Qa(t,n);return}}i!=null&&i.handleHlsError(a,o)||Qa(t,o)}),n.on(b.Events.MANIFEST_LOADED,()=>{i?.onManifestLoaded();let e=D.get(t);e!=null&&e.networkError||e&&e.error&&(e.error=null,e.retryCount=0,t.dispatchEvent(new Event(`emptied`)),t.dispatchEvent(new Event(`loadstart`)))}),t.addEventListener(`error`,$a),T(t,`waiting`,s),Ur(e,n),Zr(t,n),n.attachMedia(t)}else console.error(`It looks like the video you're trying to play will not work on this system! If possible, try upgrading to the newest versions of your browser or software.`)};function Xa(e){let t=e.target,n=D.get(t)?.startTime;if(n&&vr(t.seekable,t.duration,n)){let e=t.preload===`auto`;e&&(t.preload=`none`),t.currentTime=n,e&&(t.preload=`auto`)}}async function Za(e){if(!e.isTrusted)return;e.stopImmediatePropagation();let t=e.target;if(!(t!=null&&t.error))return;let{message:n,code:r}=t.error,i=new C(n,r);if(t.src&&r===C.MEDIA_ERR_SRC_NOT_SUPPORTED&&t.readyState===HTMLMediaElement.HAVE_NOTHING)setTimeout(()=>{(va(t)??t.error)?.code===C.MEDIA_ERR_SRC_NOT_SUPPORTED&&Qa(t,i)},500);else{if(t.src&&(r!==C.MEDIA_ERR_DECODE||r!==void 0))try{let{status:e}=await fetch(t.src);i.data={response:{code:e}}}catch{}Qa(t,i)}}function Qa(e,t){t.fatal&&((D.get(e)??{}).error=t,e.dispatchEvent(new CustomEvent(`error`,{detail:t})))}function $a(e){var t;if(!(e instanceof CustomEvent)||!(e.detail instanceof C))return;let n=e.target,r=e.detail;!r||!r.fatal||((D.get(n)??{}).error=r,(t=n.mux)==null||t.emit(`error`,{player_error_code:r.code,player_error_message:r.message,player_error_context:r.context}))}var eo=(e,t)=>{e.fatal?console.error(`getErrorFromHlsErrorData()`,e):t.debug&&console.warn(`getErrorFromHlsErrorData() (non-fatal)`,e);let n={[b.ErrorTypes.NETWORK_ERROR]:C.MEDIA_ERR_NETWORK,[b.ErrorTypes.MEDIA_ERROR]:C.MEDIA_ERR_DECODE,[b.ErrorTypes.KEY_SYSTEM_ERROR]:C.MEDIA_ERR_ENCRYPTED},r=e=>[b.ErrorDetails.KEY_SYSTEM_LICENSE_REQUEST_FAILED,b.ErrorDetails.KEY_SYSTEM_SERVER_CERTIFICATE_REQUEST_FAILED].includes(e.details)?C.MEDIA_ERR_NETWORK:n[e.type],i=e=>{if(e.type===b.ErrorTypes.KEY_SYSTEM_ERROR)return x.DRM;if(e.type===b.ErrorTypes.NETWORK_ERROR)return x.VIDEO},a,o=r(e);if(o===C.MEDIA_ERR_NETWORK&&e.response){let n=i(e)??x.VIDEO;a=Di(e.response,n,t,e.fatal)??new C(``,o,e.fatal)}else o===C.MEDIA_ERR_ENCRYPTED?e.details===b.ErrorDetails.KEY_SYSTEM_NO_CONFIGURED_LICENSE?(a=new C(E(`Attempting to play DRM-protected content without providing a DRM token.`),C.MEDIA_ERR_ENCRYPTED,e.fatal),a.errorCategory=x.DRM,a.muxCode=S.ENCRYPTED_MISSING_TOKEN):e.details===b.ErrorDetails.KEY_SYSTEM_NO_ACCESS?(a=new C(E(`Cannot play DRM-protected content with current security configuration on this browser. Try playing in another browser.`),C.MEDIA_ERR_ENCRYPTED,e.fatal),a.errorCategory=x.DRM,a.muxCode=S.ENCRYPTED_UNSUPPORTED_KEY_SYSTEM):e.details===b.ErrorDetails.KEY_SYSTEM_NO_SESSION?(a=new C(E(`Failed to generate a DRM license request. This may be an issue with the player or your protected content.`),C.MEDIA_ERR_ENCRYPTED,!0),a.errorCategory=x.DRM,a.muxCode=S.ENCRYPTED_GENERATE_REQUEST_FAILED):e.details===b.ErrorDetails.KEY_SYSTEM_SESSION_UPDATE_FAILED?(a=new C(E(`Failed to update DRM license. This may be an issue with the player or your protected content.`),C.MEDIA_ERR_ENCRYPTED,e.fatal),a.errorCategory=x.DRM,a.muxCode=S.ENCRYPTED_UPDATE_LICENSE_FAILED):e.details===b.ErrorDetails.KEY_SYSTEM_SERVER_CERTIFICATE_UPDATE_FAILED?(a=new C(E(`Your server certificate failed when attempting to set it. This may be an issue with a no longer valid certificate.`),C.MEDIA_ERR_ENCRYPTED,e.fatal),a.errorCategory=x.DRM,a.muxCode=S.ENCRYPTED_UPDATE_SERVER_CERT_FAILED):e.details===b.ErrorDetails.KEY_SYSTEM_STATUS_INTERNAL_ERROR?(a=new C(E(`The DRM Content Decryption Module system had an internal failure. Try reloading the page, updating your browser, or playing in another browser.`),C.MEDIA_ERR_ENCRYPTED,e.fatal),a.errorCategory=x.DRM,a.muxCode=S.ENCRYPTED_CDM_ERROR):e.details===b.ErrorDetails.KEY_SYSTEM_STATUS_OUTPUT_RESTRICTED?(a=new C(E(`DRM playback is being attempted in an environment that is not sufficiently secure. User may see black screen.`),C.MEDIA_ERR_ENCRYPTED,!1),a.errorCategory=x.DRM,a.muxCode=S.ENCRYPTED_OUTPUT_RESTRICTED):(a=new C(e.error.message,C.MEDIA_ERR_ENCRYPTED,e.fatal),a.errorCategory=x.DRM,a.muxCode=S.ENCRYPTED_ERROR):a=new C(``,o,e.fatal);return a.context||(a.context=`${e.url?`url: ${e.url}
`:``}${e.response&&(e.response.code||e.response.text)?`response: ${e.response.code}, ${e.response.text}
`:``}${e.reason?`failure reason: ${e.reason}
`:``}${e.level?`level: ${e.level}
`:``}${e.parent?`parent stream controller: ${e.parent}
`:``}${e.buffer?`buffer length: ${e.buffer}
`:``}${e.error?`error: ${e.error}
`:``}${e.event?`event: ${e.event}
`:``}${e.err?`error message: ${e.err?.message}
`:``}`),a.data=e,a},to=e=>{throw TypeError(e)},no=(e,t,n)=>t.has(e)||to(`Cannot `+n),ro=(e,t,n)=>(no(e,t,`read from private field`),n?n.call(e):t.get(e)),io=(e,t,n)=>t.has(e)?to(`Cannot add the same private member more than once`):t instanceof WeakSet?t.add(e):t.set(e,n),ao=(e,t,n,r)=>(no(e,t,`write to private field`),r?r.call(e,n):t.set(e,n),n),oo=(e,t,n)=>(no(e,t,`access private method`),n),so=(()=>{try{return`0.31.6`}catch{}return`UNKNOWN`})(),co=()=>so,lo=`
<svg xmlns="http://www.w3.org/2000/svg" xml:space="preserve" part="logo" style="fill-rule:evenodd;clip-rule:evenodd;stroke-linejoin:round;stroke-miterlimit:2" viewBox="0 0 1600 500"><g fill="#fff"><path d="M994.287 93.486c-17.121 0-31-13.879-31-31 0-17.121 13.879-31 31-31 17.121 0 31 13.879 31 31 0 17.121-13.879 31-31 31m0-93.486c-34.509 0-62.484 27.976-62.484 62.486v187.511c0 68.943-56.09 125.033-125.032 125.033s-125.03-56.09-125.03-125.033V62.486C681.741 27.976 653.765 0 619.256 0s-62.484 27.976-62.484 62.486v187.511C556.772 387.85 668.921 500 806.771 500c137.851 0 250.001-112.15 250.001-250.003V62.486c0-34.51-27.976-62.486-62.485-62.486M1537.51 468.511c-17.121 0-31-13.879-31-31 0-17.121 13.879-31 31-31 17.121 0 31 13.879 31 31 0 17.121-13.879 31-31 31m-275.883-218.509-143.33 143.329c-24.402 24.402-24.402 63.966 0 88.368 24.402 24.402 63.967 24.402 88.369 0l143.33-143.329 143.328 143.329c24.402 24.4 63.967 24.402 88.369 0 24.403-24.402 24.403-63.966.001-88.368l-143.33-143.329.001-.004 143.329-143.329c24.402-24.402 24.402-63.965 0-88.367s-63.967-24.402-88.369 0L1349.996 161.63 1206.667 18.302c-24.402-24.401-63.967-24.402-88.369 0s-24.402 63.965 0 88.367l143.329 143.329v.004ZM437.511 468.521c-17.121 0-31-13.879-31-31 0-17.121 13.879-31 31-31 17.121 0 31 13.879 31 31 0 17.121-13.879 31-31 31M461.426 4.759C438.078-4.913 411.2.432 393.33 18.303L249.999 161.632 106.669 18.303C88.798.432 61.922-4.913 38.573 4.759 15.224 14.43-.001 37.214-.001 62.488v375.026c0 34.51 27.977 62.486 62.487 62.486 34.51 0 62.486-27.976 62.486-62.486V213.341l80.843 80.844c24.404 24.402 63.965 24.402 88.369 0l80.843-80.844v224.173c0 34.51 27.976 62.486 62.486 62.486s62.486-27.976 62.486-62.486V62.488c0-25.274-15.224-48.058-38.573-57.729" style="fill-rule:nonzero"/></g></svg>`;function uo(e){return e.replace(/&/g,`&amp;`).replace(/</g,`&lt;`).replace(/>/g,`&gt;`).replace(/"/g,`&quot;`).replace(/'/g,`&#39;`)}var O={BEACON_COLLECTION_DOMAIN:`beacon-collection-domain`,CUSTOM_DOMAIN:`custom-domain`,DEBUG:`debug`,DISABLE_TRACKING:`disable-tracking`,DISABLE_COOKIES:`disable-cookies`,DISABLE_PSEUDO_ENDED:`disable-pseudo-ended`,MAX_RECONNECT_RETRIES:`max-reconnect-retries`,DRM_TOKEN:`drm-token`,PLAYBACK_TOKEN:`playback-token`,ENV_KEY:`env-key`,MAX_RESOLUTION:`max-resolution`,MIN_RESOLUTION:`min-resolution`,MAX_AUTO_RESOLUTION:`max-auto-resolution`,RENDITION_ORDER:`rendition-order`,PROGRAM_START_TIME:`program-start-time`,PROGRAM_END_TIME:`program-end-time`,ASSET_START_TIME:`asset-start-time`,ASSET_END_TIME:`asset-end-time`,METADATA_URL:`metadata-url`,PLAYBACK_ID:`playback-id`,PLAYER_SOFTWARE_NAME:`player-software-name`,PLAYER_SOFTWARE_VERSION:`player-software-version`,PLAYER_INIT_TIME:`player-init-time`,PREFER_CMCD:`prefer-cmcd`,PREFER_PLAYBACK:`prefer-playback`,START_TIME:`start-time`,STREAM_TYPE:`stream-type`,TARGET_LIVE_WINDOW:`target-live-window`,LIVE_EDGE_OFFSET:`live-edge-offset`,TYPE:`type`,LOGO:`logo`,CAP_RENDITION_TO_PLAYER_SIZE:`cap-rendition-to-player-size`,INITIAL_BANDWIDTH_ESTIMATE_KBPS:`initial-bandwidth-estimate-kbps`,INITIAL_ESTIMATE_SEGMENTS:`initial-estimate-segments`,MIN_PRELOAD_SEGMENTS:`min-preload-segments`},fo=Object.values(O),po=co(),mo=`mux-video`,ho,go,_o,vo,yo,bo,xo,So,Co,wo,To,Eo,Do,Oo,ko=class extends i{constructor(){super(),io(this,To),io(this,ho),io(this,go),io(this,_o,{}),io(this,vo,{}),io(this,yo),io(this,bo),io(this,xo),io(this,So),io(this,Co,``),io(this,wo,e=>{let t=ya(this.nativeEl),n=this.metadata??{};this.metadata={...t,...n},t?.[`com.mux.video.branding`]===`mux-free-plan`&&(ao(this,Co,`default`),this.updateLogo())}),io(this,Do),ao(this,go,fa())}static get NAME(){return mo}static get VERSION(){return po}static get observedAttributes(){return[...fo,...i.observedAttributes??[]]}static getLogoHTML(e){return!e||e===`false`?``:e==="default"?lo:`<img part="logo" src="${uo(e)}" />`}static getTemplateHTML(e={}){return`
      ${i.getTemplateHTML(e)}
      <style>
        :host {
          position: relative;
        }
        slot[name="logo"] {
          display: flex;
          justify-content: end;
          position: absolute;
          top: 1rem;
          right: 1rem;
          opacity: 0;
          transition: opacity 0.25s ease-in-out;
          z-index: 1;
        }
        slot[name="logo"]:has([part="logo"]) {
          opacity: 1;
        }
        slot[name="logo"] [part="logo"] {
          width: 5rem;
          pointer-events: none;
          user-select: none;
        }
      </style>
      <slot name="logo">
        ${this.getLogoHTML(e[O.LOGO]??``)}
      </slot>
    `}get preferCmcd(){return this.getAttribute(O.PREFER_CMCD)??void 0}set preferCmcd(e){e!==this.preferCmcd&&(e?lr.includes(e)?this.setAttribute(O.PREFER_CMCD,e):console.warn(`Invalid value for preferCmcd. Must be one of ${lr.join()}`):this.removeAttribute(O.PREFER_CMCD))}get playerInitTime(){return this.hasAttribute(O.PLAYER_INIT_TIME)?+this.getAttribute(O.PLAYER_INIT_TIME):ro(this,go)}set playerInitTime(e){e!=this.playerInitTime&&(e==null?this.removeAttribute(O.PLAYER_INIT_TIME):this.setAttribute(O.PLAYER_INIT_TIME,`${+e}`))}get playerSoftwareName(){return ro(this,xo)??mo}set playerSoftwareName(e){ao(this,xo,e)}get playerSoftwareVersion(){return ro(this,bo)??po}set playerSoftwareVersion(e){ao(this,bo,e)}get _hls(){return ro(this,To,Eo)?.engine}get mux(){return this.nativeEl?.mux}get error(){return va(this.nativeEl)??null}get errorTranslator(){return ro(this,So)}set errorTranslator(e){ao(this,So,e)}get src(){return this.getAttribute(`src`)}set src(e){e!==this.src&&(e==null?this.removeAttribute(`src`):this.setAttribute(`src`,e))}get type(){return this.getAttribute(O.TYPE)??void 0}set type(e){e!==this.type&&(e?this.setAttribute(O.TYPE,e):this.removeAttribute(O.TYPE))}get preload(){let e=this.getAttribute(`preload`);return e===``?`auto`:[`none`,`metadata`,`auto`].includes(e)?e:super.preload}set preload(e){e!=this.getAttribute(`preload`)&&([``,`none`,`metadata`,`auto`].includes(e)?this.setAttribute(`preload`,e):this.removeAttribute(`preload`))}get debug(){return this.getAttribute(O.DEBUG)!=null}set debug(e){e!==this.debug&&(e?this.setAttribute(O.DEBUG,``):this.removeAttribute(O.DEBUG))}get disableTracking(){return this.hasAttribute(O.DISABLE_TRACKING)}set disableTracking(e){e!==this.disableTracking&&this.toggleAttribute(O.DISABLE_TRACKING,!!e)}get disableCookies(){return this.hasAttribute(O.DISABLE_COOKIES)}set disableCookies(e){e!==this.disableCookies&&(e?this.setAttribute(O.DISABLE_COOKIES,``):this.removeAttribute(O.DISABLE_COOKIES))}get disablePseudoEnded(){return this.hasAttribute(O.DISABLE_PSEUDO_ENDED)}set disablePseudoEnded(e){e!==this.disablePseudoEnded&&(e?this.setAttribute(O.DISABLE_PSEUDO_ENDED,``):this.removeAttribute(O.DISABLE_PSEUDO_ENDED))}get maxReconnectRetries(){let e=this.getAttribute(O.MAX_RECONNECT_RETRIES);if(e==null)return;let t=+e;return Number.isNaN(t)?void 0:t}set maxReconnectRetries(e){e!==this.maxReconnectRetries&&(e==null?this.removeAttribute(O.MAX_RECONNECT_RETRIES):this.setAttribute(O.MAX_RECONNECT_RETRIES,`${e}`))}get startTime(){let e=this.getAttribute(O.START_TIME);if(e==null)return;let t=+e;return Number.isNaN(t)?void 0:t}set startTime(e){e!==this.startTime&&(e==null?this.removeAttribute(O.START_TIME):this.setAttribute(O.START_TIME,`${e}`))}get initialBandwidthEstimateKbps(){let e=this.getAttribute(O.INITIAL_BANDWIDTH_ESTIMATE_KBPS);if(e==null)return;let t=+e;return Number.isNaN(t)?void 0:t}set initialBandwidthEstimateKbps(e){e!==this.initialBandwidthEstimateKbps&&(e==null?this.removeAttribute(O.INITIAL_BANDWIDTH_ESTIMATE_KBPS):this.setAttribute(O.INITIAL_BANDWIDTH_ESTIMATE_KBPS,`${e}`))}get initialEstimateSegments(){let e=this.getAttribute(O.INITIAL_ESTIMATE_SEGMENTS);if(e==null)return;let t=+e;return Number.isNaN(t)?void 0:t}set initialEstimateSegments(e){e!==this.initialEstimateSegments&&(e==null?this.removeAttribute(O.INITIAL_ESTIMATE_SEGMENTS):this.setAttribute(O.INITIAL_ESTIMATE_SEGMENTS,`${e}`))}get minPreloadSegments(){let e=this.getAttribute(O.MIN_PRELOAD_SEGMENTS);if(e==null)return;let t=+e;return Number.isNaN(t)?void 0:t}set minPreloadSegments(e){e!==this.minPreloadSegments&&(e==null?this.removeAttribute(O.MIN_PRELOAD_SEGMENTS):this.setAttribute(O.MIN_PRELOAD_SEGMENTS,`${e}`))}get playbackId(){return this.hasAttribute(O.PLAYBACK_ID)?this.getAttribute(O.PLAYBACK_ID):ga(this.src)??void 0}set playbackId(e){e!==this.playbackId&&(e?this.setAttribute(O.PLAYBACK_ID,e):this.removeAttribute(O.PLAYBACK_ID))}get maxResolution(){return this.getAttribute(O.MAX_RESOLUTION)??void 0}set maxResolution(e){e!==this.maxResolution&&(e?this.setAttribute(O.MAX_RESOLUTION,e):this.removeAttribute(O.MAX_RESOLUTION))}get minResolution(){return this.getAttribute(O.MIN_RESOLUTION)??void 0}set minResolution(e){e!==this.minResolution&&(e?this.setAttribute(O.MIN_RESOLUTION,e):this.removeAttribute(O.MIN_RESOLUTION))}get maxAutoResolution(){return this.getAttribute(O.MAX_AUTO_RESOLUTION)??void 0}set maxAutoResolution(e){e==null?this.removeAttribute(O.MAX_AUTO_RESOLUTION):this.setAttribute(O.MAX_AUTO_RESOLUTION,e)}get renditionOrder(){return this.getAttribute(O.RENDITION_ORDER)??void 0}set renditionOrder(e){e!==this.renditionOrder&&(e?this.setAttribute(O.RENDITION_ORDER,e):this.removeAttribute(O.RENDITION_ORDER))}get programStartTime(){let e=this.getAttribute(O.PROGRAM_START_TIME);if(e==null)return;let t=+e;return Number.isNaN(t)?void 0:t}set programStartTime(e){e==null?this.removeAttribute(O.PROGRAM_START_TIME):this.setAttribute(O.PROGRAM_START_TIME,`${e}`)}get programEndTime(){let e=this.getAttribute(O.PROGRAM_END_TIME);if(e==null)return;let t=+e;return Number.isNaN(t)?void 0:t}set programEndTime(e){e==null?this.removeAttribute(O.PROGRAM_END_TIME):this.setAttribute(O.PROGRAM_END_TIME,`${e}`)}get assetStartTime(){let e=this.getAttribute(O.ASSET_START_TIME);if(e==null)return;let t=+e;return Number.isNaN(t)?void 0:t}set assetStartTime(e){e==null?this.removeAttribute(O.ASSET_START_TIME):this.setAttribute(O.ASSET_START_TIME,`${e}`)}get assetEndTime(){let e=this.getAttribute(O.ASSET_END_TIME);if(e==null)return;let t=+e;return Number.isNaN(t)?void 0:t}set assetEndTime(e){e==null?this.removeAttribute(O.ASSET_END_TIME):this.setAttribute(O.ASSET_END_TIME,`${e}`)}get customDomain(){return this.getAttribute(O.CUSTOM_DOMAIN)??void 0}set customDomain(e){e!==this.customDomain&&(e?this.setAttribute(O.CUSTOM_DOMAIN,e):this.removeAttribute(O.CUSTOM_DOMAIN))}get capRenditionToPlayerSize(){return this._hlsConfig?.capLevelToPlayerSize==null?ro(this,Do):this._hlsConfig.capLevelToPlayerSize}set capRenditionToPlayerSize(e){ao(this,Do,e)}get drmToken(){return this.getAttribute(O.DRM_TOKEN)??void 0}set drmToken(e){e!==this.drmToken&&(e?this.setAttribute(O.DRM_TOKEN,e):this.removeAttribute(O.DRM_TOKEN))}get playbackToken(){if(this.hasAttribute(O.PLAYBACK_TOKEN))return this.getAttribute(O.PLAYBACK_TOKEN)??void 0;if(this.hasAttribute(O.PLAYBACK_ID)){let[,e]=yr(this.playbackId??``);return new URLSearchParams(e).get(`token`)??void 0}if(this.src)return new URLSearchParams(this.src).get(`token`)??void 0}set playbackToken(e){e!==this.playbackToken&&(e?this.setAttribute(O.PLAYBACK_TOKEN,e):this.removeAttribute(O.PLAYBACK_TOKEN))}get tokens(){let e=this.getAttribute(O.PLAYBACK_TOKEN),t=this.getAttribute(O.DRM_TOKEN);return{...ro(this,vo),...e==null?{}:{playback:e},...t==null?{}:{drm:t}}}set tokens(e){ao(this,vo,e??{})}get ended(){return Aa(this.nativeEl,this._hls)}get envKey(){return this.getAttribute(O.ENV_KEY)??void 0}set envKey(e){e!==this.envKey&&(e?this.setAttribute(O.ENV_KEY,e):this.removeAttribute(O.ENV_KEY))}get beaconCollectionDomain(){return this.getAttribute(O.BEACON_COLLECTION_DOMAIN)??void 0}set beaconCollectionDomain(e){e!==this.beaconCollectionDomain&&(e?this.setAttribute(O.BEACON_COLLECTION_DOMAIN,e):this.removeAttribute(O.BEACON_COLLECTION_DOMAIN))}get streamType(){return this.getAttribute(O.STREAM_TYPE)??ba(this.nativeEl)}set streamType(e){e!==this.streamType&&(e?this.setAttribute(O.STREAM_TYPE,e):this.removeAttribute(O.STREAM_TYPE))}get targetLiveWindow(){return this.hasAttribute(O.TARGET_LIVE_WINDOW)?+this.getAttribute(O.TARGET_LIVE_WINDOW):xa(this.nativeEl)}set targetLiveWindow(e){e!=this.targetLiveWindow&&(e==null?this.removeAttribute(O.TARGET_LIVE_WINDOW):this.setAttribute(O.TARGET_LIVE_WINDOW,`${+e}`))}get liveEdgeStart(){if(this.hasAttribute(O.LIVE_EDGE_OFFSET)){let{liveEdgeOffset:e}=this,t=this.nativeEl.seekable.end(0)??0,n=this.nativeEl.seekable.start(0)??0;return Math.max(n,t-e)}return Ca(this.nativeEl)}get liveEdgeOffset(){if(this.hasAttribute(O.LIVE_EDGE_OFFSET))return+this.getAttribute(O.LIVE_EDGE_OFFSET)}set liveEdgeOffset(e){e!=this.liveEdgeOffset&&(e==null?this.removeAttribute(O.LIVE_EDGE_OFFSET):this.setAttribute(O.LIVE_EDGE_OFFSET,`${+e}`))}get seekable(){return Sa(this.nativeEl)}async addCuePoints(e){return this.nativeEl.currentSrc||console.warn(`addCuePoints() was called before the media element has loaded. Wait for the loadstart event before calling addCuePoints().`),si(this.nativeEl,e)}get activeCuePoint(){return ui(this.nativeEl)}get cuePoints(){return li(this.nativeEl)}async addChapters(e){return this.nativeEl.currentSrc||console.warn(`addChapters() was called before the media element has loaded. Wait for the loadstart event before calling addChapters().`),_i(this.nativeEl,e)}get activeChapter(){return bi(this.nativeEl)}get chapters(){return yi(this.nativeEl)}getStartDate(){return Si(this.nativeEl,this._hls)}get currentPdt(){return Ci(this.nativeEl,this._hls)}get preferPlayback(){let e=this.getAttribute(O.PREFER_PLAYBACK);if(e===sr.MSE||e===sr.NATIVE)return e}set preferPlayback(e){e!==this.preferPlayback&&(e===sr.MSE||e===sr.NATIVE?this.setAttribute(O.PREFER_PLAYBACK,e):this.removeAttribute(O.PREFER_PLAYBACK))}get metadata(){return{...this.getAttributeNames().filter(e=>e.startsWith(`metadata-`)&&![O.METADATA_URL].includes(e)).reduce((e,t)=>{let n=this.getAttribute(t);return n!=null&&(e[t.replace(/^metadata-/,``).replace(/-/g,`_`)]=n),e},{}),...ro(this,_o)}}set metadata(e){ao(this,_o,e??{}),this.mux&&this.mux.emit(`hb`,ro(this,_o))}get _hlsConfig(){return ro(this,yo)}set _hlsConfig(e){ao(this,yo,e)}get logo(){return this.getAttribute(O.LOGO)??ro(this,Co)}set logo(e){e?this.setAttribute(O.LOGO,e):this.removeAttribute(O.LOGO)}load(){ja(this,this.nativeEl,ro(this,To,Eo))}unload(){Ia(this.nativeEl,ro(this,To,Eo),this)}attributeChangedCallback(e,t,n){var r,a;switch(i.observedAttributes.includes(e)&&![`src`,`autoplay`,`preload`].includes(e)&&super.attributeChangedCallback(e,t,n),e){case O.PLAYER_SOFTWARE_NAME:this.playerSoftwareName=n??void 0;break;case O.PLAYER_SOFTWARE_VERSION:this.playerSoftwareVersion=n??void 0;break;case`src`:{let e=!!t,r=!!n;!e&&r?oo(this,To,Oo).call(this):e&&!r?this.unload():e&&r&&(this.unload(),oo(this,To,Oo).call(this));break}case`autoplay`:if(n===t)break;(r=ro(this,To,Eo))==null||r.setAutoplay(this.autoplay);break;case`preload`:if(n===t)break;(a=ro(this,To,Eo))==null||a.setPreload(n);break;case O.PLAYBACK_ID:case O.CUSTOM_DOMAIN:case O.MAX_RESOLUTION:case O.MIN_RESOLUTION:case O.RENDITION_ORDER:case O.PROGRAM_START_TIME:case O.PROGRAM_END_TIME:case O.ASSET_START_TIME:case O.ASSET_END_TIME:case O.PLAYBACK_TOKEN:this.hasAttribute(O.PLAYBACK_ID)&&(this.src=ma(this));break;case O.DEBUG:{let e=this.debug;this.mux&&console.info(`Cannot toggle debug mode of mux data after initialization. Make sure you set all metadata to override before setting the src.`),this._hls&&(this._hls.config.debug=e);break}case O.METADATA_URL:n&&fetch(n).then(e=>e.json()).then(e=>this.metadata=e).catch(()=>console.error(`Unable to load or parse metadata JSON from metadata-url ${n}!`));break;case O.STREAM_TYPE:(n==null||n!==t)&&this.dispatchEvent(new CustomEvent(`streamtypechange`,{composed:!0,bubbles:!0}));break;case O.TARGET_LIVE_WINDOW:(n==null||n!==t)&&this.dispatchEvent(new CustomEvent(`targetlivewindowchange`,{composed:!0,bubbles:!0,detail:this.targetLiveWindow}));break;case O.LOGO:(n==null||n!==t)&&this.updateLogo();break;case O.DISABLE_TRACKING:if(n==null||n!==t){let e=this.currentTime,t=this.paused;this.unload(),oo(this,To,Oo).call(this).then(()=>{this.currentTime=e,t||this.play()})}break;case O.DISABLE_COOKIES:(n==null||n!==t)&&Fa(this,this.nativeEl,ro(this,To,Eo));break;case O.CAP_RENDITION_TO_PLAYER_SIZE:(n==null||n!==t)&&(this.capRenditionToPlayerSize=n!=null||void 0)}}updateLogo(){if(!this.shadowRoot)return;let e=this.shadowRoot.querySelector(`slot[name="logo"]`);e&&(e.innerHTML=this.constructor.getLogoHTML(ro(this,Co)||this.logo))}connectedCallback(){var e,t;(e=super.connectedCallback)==null||e.call(this),(t=this.nativeEl)==null||t.addEventListener(`muxmetadata`,ro(this,wo)),this.nativeEl&&this.src&&!ro(this,To,Eo)&&oo(this,To,Oo).call(this)}disconnectedCallback(){var e,t;(e=this.nativeEl)==null||e.removeEventListener(`muxmetadata`,ro(this,wo)),this.unload(),(t=super.disconnectedCallback)==null||t.call(this)}handleEvent(e){e.target===this.nativeEl&&this.dispatchEvent(new CustomEvent(e.type,{composed:!0,detail:e.detail}))}};ho=new WeakMap,go=new WeakMap,_o=new WeakMap,vo=new WeakMap,yo=new WeakMap,bo=new WeakMap,xo=new WeakMap,So=new WeakMap,Co=new WeakMap,wo=new WeakMap,To=new WeakSet,Eo=function(){return wa(this.nativeEl)},Do=new WeakMap,Oo=async function(){ro(this,ho)||(await ao(this,ho,Promise.resolve()),ao(this,ho,null),this.load())};var Ao=new WeakMap,jo=class extends Error{},Mo=class extends Error{},No=[`application/x-mpegURL`,`application/vnd.apple.mpegurl`,`audio/mpegurl`],Po=globalThis.WeakRef?class extends Set{add(e){super.add(new WeakRef(e))}forEach(e){super.forEach(t=>{let n=t.deref();n&&e(n)})}}:Set;function Fo(e){globalThis.chrome?.cast?.isAvailable?globalThis.cast?.framework?e():customElements.whenDefined(`google-cast-button`).then(e):globalThis.__onGCastApiAvailable=()=>{customElements.whenDefined(`google-cast-button`).then(e)}}function Io(){return globalThis.chrome}function Lo(){let e=`https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1`;if(globalThis.chrome?.cast||document.querySelector(`script[src="${e}"]`))return;let t=document.createElement(`script`);t.src=e,document.head.append(t)}function Ro(){return globalThis.cast?.framework?.CastContext.getInstance()}function zo(){return Ro()?.getCurrentSession()}function Bo(){return zo()?.getSessionObj().media[0]}function Vo(e){return new Promise((t,n)=>{Bo().editTracksInfo(e,t,n)})}function Ho(e){return new Promise((t,n)=>{Bo().getStatus(e,t,n)})}function Uo(e){return Ro().setOptions({...Wo(),...e})}function Wo(){return{receiverApplicationId:`CC1AD845`,autoJoinPolicy:`origin_scoped`,androidReceiverCompatible:!1,language:`en-US`,resumeSavedSession:!0}}function Go(e){if(!e)return;let t=e.match(/\.([a-zA-Z0-9]+)(?:\?.*)?$/);return t?t[1]:null}function Ko(e){for(let t of e.split(`
`)){let e=t.trim();if(e.startsWith(`#EXT-X-MEDIA`)&&/TYPE=AUDIO/i.test(e)){let t=e.match(/URI="([^"]+)"/i);if(t)return t[1]}}}function qo(e){let t=e.split(`
`),n=[];for(let e=0;e<t.length;e++)if(t[e].trim().startsWith(`#EXT-X-STREAM-INF`)){let r=t[e+1]?t[e+1].trim():``;r&&!r.startsWith(`#`)&&n.push(r)}return n}function Jo(e){return e.split(`
`).find(e=>!e.trim().startsWith(`#`)&&e.trim()!==``)?.trim()}async function Yo(e){if(!e)return!1;if(/\.m3u8?(\?.*)?$/i.test(e))return!0;if(e.startsWith(`blob:`))return!1;try{let t=(await fetch(e,{method:`HEAD`})).headers.get(`Content-Type`);return No.some(e=>t===e)}catch(e){return console.error(`Error while trying to get the Content-Type of the manifest`,e),!1}}async function Xo(e){if(!e||e.startsWith(`blob:`))return{videoFormat:void 0,audioFormat:void 0};try{let t=await(await fetch(e)).text(),n=t,r=qo(t);if(r.length>0){let t=new URL(r[0],e).toString();n=await(await fetch(t)).text()}let i=Go(Jo(n)),a=Ko(t),o=i;if(a)try{let t=new URL(a,e).toString();o=Go(Jo(await(await fetch(t)).text()))??i}catch(e){console.error(`Error while trying to parse the audio rendition playlist`,e)}return{videoFormat:i,audioFormat:o}}catch(e){return console.error(`Error while trying to parse the manifest playlist`,e),{videoFormat:void 0,audioFormat:void 0}}}var Zo=new Po,Qo=new WeakSet,$o;Fo(()=>{globalThis.chrome?.cast?.isAvailable?$o||($o=cast.framework,Ro().addEventListener($o.CastContextEventType.CAST_STATE_CHANGED,e=>{Zo.forEach(t=>Ao.get(t).onCastStateChanged?.(e))}),Ro().addEventListener($o.CastContextEventType.SESSION_STATE_CHANGED,e=>{Zo.forEach(t=>Ao.get(t).onSessionStateChanged?.(e))}),Zo.forEach(e=>Ao.get(e).init?.())):console.debug(`chrome.cast.isAvailable`,globalThis.chrome?.cast?.isAvailable)});var es=0,ts=class extends EventTarget{#e;#t;#n;#r;#i=`disconnected`;#a=!1;#o=new Set;#s=new WeakMap;#c=()=>this.#g();constructor(e){super(),this.#e=e,Zo.add(this),Ao.set(this,{init:()=>this.#m(),onCastStateChanged:()=>this.#f(),onSessionStateChanged:()=>this.#p(),getCastPlayer:()=>this.#l}),this.#m()}destroy(){this.#e?.textTracks?.removeEventListener(`change`,this.#c),this.#r&&this.#n?.controller&&Object.entries(this.#r).forEach(([e,t])=>{this.#n.controller.removeEventListener(e,t)}),this.#e&&Qo.delete(this.#e),this.#t=!1}get#l(){if(Qo.has(this.#e))return this.#n}get state(){return this.#i}async watchAvailability(e){if(this.#e.disableRemotePlayback)throw new jo(`disableRemotePlayback attribute is present.`);return this.#s.set(e,++es),this.#o.add(e),queueMicrotask(()=>e(this.#d())),es}async cancelWatchAvailability(e){if(this.#e.disableRemotePlayback)throw new jo(`disableRemotePlayback attribute is present.`);e?this.#o.delete(e):this.#o.clear()}async prompt(){if(this.#e.disableRemotePlayback)throw new jo(`disableRemotePlayback attribute is present.`);if(!globalThis.chrome?.cast?.isAvailable)throw new Mo(`The RemotePlayback API is disabled on this platform.`);let e=Qo.has(this.#e);Qo.add(this.#e),Uo(this.#e.castOptions),Object.entries(this.#r).forEach(([e,t])=>{this.#n.controller.addEventListener(e,t)});try{await Ro().requestSession()}catch(t){if(e||Qo.delete(this.#e),t===`cancel`)return;throw Error(t)}Ao.get(this.#e)?.loadOnPrompt?.()}#u(){Qo.has(this.#e)&&(Object.entries(this.#r).forEach(([e,t])=>{this.#n.controller.removeEventListener(e,t)}),Qo.delete(this.#e),this.#e.muted=this.#n.isMuted,this.#e.currentTime=this.#n.savedPlayerState.currentTime,this.#n.savedPlayerState.isPaused===!1&&this.#e.play())}#d(){let e=Ro()?.getCastState();return e&&e!==`NO_DEVICES_AVAILABLE`}#f(){let e=Ro().getCastState();if(Qo.has(this.#e)&&e===`CONNECTING`&&(this.#i=`connecting`,this.dispatchEvent(new Event(`connecting`))),!this.#a&&e?.includes(`CONNECT`)){this.#a=!0;for(let e of this.#o)e(!0)}else if(this.#a&&(!e||e===`NO_DEVICES_AVAILABLE`)){this.#a=!1;for(let e of this.#o)e(!1)}}async#p(){let{SESSION_RESUMED:e}=$o.SessionState;if(Ro().getSessionState()===e&&this.#e.castSrc===Bo()?.media.contentId){Qo.add(this.#e),Object.entries(this.#r).forEach(([e,t])=>{this.#n.controller.addEventListener(e,t)});try{await Ho(new chrome.cast.media.GetStatusRequest)}catch(e){console.error(e)}this.#r[$o.RemotePlayerEventType.IS_PAUSED_CHANGED](),this.#r[$o.RemotePlayerEventType.PLAYER_STATE_CHANGED]()}}#m(){!$o||this.#t||(this.#t=!0,Uo(this.#e.castOptions),this.#e.textTracks.addEventListener(`change`,this.#c),this.#f(),this.#n=new $o.RemotePlayer,new $o.RemotePlayerController(this.#n),this.#r={[$o.RemotePlayerEventType.IS_CONNECTED_CHANGED]:({value:e})=>{e===!0?(this.#i=`connected`,this.dispatchEvent(new Event(`connect`))):(this.#u(),this.#i=`disconnected`,this.dispatchEvent(new Event(`disconnect`)))},[$o.RemotePlayerEventType.DURATION_CHANGED]:()=>{this.#e.dispatchEvent(new Event(`durationchange`))},[$o.RemotePlayerEventType.VOLUME_LEVEL_CHANGED]:()=>{this.#e.dispatchEvent(new Event(`volumechange`))},[$o.RemotePlayerEventType.IS_MUTED_CHANGED]:()=>{this.#e.dispatchEvent(new Event(`volumechange`))},[$o.RemotePlayerEventType.CURRENT_TIME_CHANGED]:()=>{this.#l?.isMediaLoaded&&this.#e.dispatchEvent(new Event(`timeupdate`))},[$o.RemotePlayerEventType.VIDEO_INFO_CHANGED]:()=>{this.#e.dispatchEvent(new Event(`resize`))},[$o.RemotePlayerEventType.IS_PAUSED_CHANGED]:()=>{this.#e.dispatchEvent(new Event(this.paused?`pause`:`play`))},[$o.RemotePlayerEventType.PLAYER_STATE_CHANGED]:()=>{this.#l?.playerState!==chrome.cast.media.PlayerState.PAUSED&&this.#e.dispatchEvent(new Event({[chrome.cast.media.PlayerState.PLAYING]:`playing`,[chrome.cast.media.PlayerState.BUFFERING]:`waiting`,[chrome.cast.media.PlayerState.IDLE]:`emptied`}[this.#l?.playerState]))},[$o.RemotePlayerEventType.IS_MEDIA_LOADED_CHANGED]:async()=>{this.#l?.isMediaLoaded&&(await Promise.resolve(),this.#h())}})}#h(){this.#g()}async#g(){if(!this.#l)return;let e=(this.#n.mediaInfo?.tracks??[]).filter(({type:e})=>e===chrome.cast.media.TrackType.TEXT),t=[...this.#e.textTracks].filter(({kind:e})=>e===`subtitles`||e===`captions`),n=e.map(({language:e,name:n,trackId:r})=>{let{mode:i}=t.find(t=>t.language===e&&t.label===n)??{};return i?{mode:i,trackId:r}:!1}).filter(Boolean),r=n.filter(({mode:e})=>e!==`showing`).map(({trackId:e})=>e),i=n.find(({mode:e})=>e===`showing`),a=zo()?.getSessionObj().media[0]?.activeTrackIds??[],o=a;if(a.length&&(o=o.filter(e=>!r.includes(e))),i?.trackId&&(o=[...o,i.trackId]),o=[...new Set(o)],!((e,t)=>e.length===t.length&&e.every(e=>t.includes(e)))(a,o))try{await Vo(new chrome.cast.media.EditTracksInfoRequest(o))}catch(e){console.error(e)}}},ns=e=>class extends e{static observedAttributes=[...e.observedAttributes??[],`cast-src`,`cast-content-type`,`cast-stream-type`,`cast-receiver`];#e={paused:!1};#t=Wo();#n;#r;get remote(){return this.#r?this.#r:Io()?this.isConnected?(this.disableRemotePlayback||Lo(),Ao.set(this,{loadOnPrompt:()=>this.#a()}),this.#r=new ts(this)):void 0:super.remote}get#i(){return Ao.get(this.#r)?.getCastPlayer?.()}disconnectedCallback(){this.#r?.destroy(),this.#r=null,Ao.delete(this),super.disconnectedCallback?.()}attributeChangedCallback(e,t,n){if(super.attributeChangedCallback(e,t,n),e===`cast-receiver`&&n)this.#t.receiverApplicationId=n;else if(this.#i)switch(e){case`cast-stream-type`:case`cast-src`:this.load()}}async#a(){this.#e.paused=super.paused,super.pause(),this.muted=super.muted;try{await this.load()}catch(e){console.error(e)}}async load(){if(!this.#i)return super.load();let e=new chrome.cast.media.MediaInfo(this.castSrc,this.castContentType);e.customData=this.castCustomData;let t=[...this.querySelectorAll(`track`)].filter(({kind:e,src:t})=>t&&(e===`subtitles`||e===`captions`)),n=[],r=0;if(t.length&&(e.tracks=t.map(e=>{let t=++r;n.length===0&&e.track.mode===`showing`&&n.push(t);let i=new chrome.cast.media.Track(t,chrome.cast.media.TrackType.TEXT);return i.trackContentId=e.src,i.trackContentType=`text/vtt`,i.subtype=e.kind===`captions`?chrome.cast.media.TextTrackType.CAPTIONS:chrome.cast.media.TextTrackType.SUBTITLES,i.name=e.label,i.language=e.srclang,i})),e.streamType=this.castStreamType===`live`?chrome.cast.media.StreamType.LIVE:chrome.cast.media.StreamType.BUFFERED,e.metadata=new chrome.cast.media.GenericMediaMetadata,e.metadata.title=this.title,e.metadata.images=[{url:this.poster}],await Yo(this.castSrc)){e.contentType||=`application/x-mpegURL`;let{videoFormat:t,audioFormat:n}=await Xo(this.castSrc);t?.includes(`m4s`)||t?.includes(`mp4`)||t?.includes(`m4a`)?(e.hlsSegmentFormat=chrome.cast.media.HlsSegmentFormat.FMP4,e.hlsVideoSegmentFormat=chrome.cast.media.HlsVideoSegmentFormat.FMP4):n?.includes(`aac`)?(e.hlsSegmentFormat=chrome.cast.media.HlsSegmentFormat.AAC,e.hlsVideoSegmentFormat=chrome.cast.media.HlsVideoSegmentFormat.MPEG2_TS):(t?.includes(`ts`)||n?.includes(`ts`))&&(e.hlsSegmentFormat=chrome.cast.media.HlsSegmentFormat.TS,e.hlsVideoSegmentFormat=chrome.cast.media.HlsVideoSegmentFormat.MPEG2_TS)}let i=new chrome.cast.media.LoadRequest(e);i.currentTime=super.currentTime??0,i.autoplay=!this.#e.paused,i.activeTrackIds=n,await zo()?.loadMedia(i),this.dispatchEvent(new Event(`volumechange`))}play(){if(this.#i)this.#i.isPaused&&this.#i.controller?.playOrPause();else return super.play()}pause(){this.#i?this.#i.isPaused||this.#i.controller?.playOrPause():super.pause()}get castOptions(){return this.#t}get castReceiver(){return this.getAttribute(`cast-receiver`)??void 0}set castReceiver(e){this.castReceiver!=e&&this.setAttribute(`cast-receiver`,`${e}`)}get castSrc(){let e=this.currentSrc,t=e?.startsWith(`blob:`)?void 0:e;return this.getAttribute(`cast-src`)??this.querySelector(`source`)?.src??t??this.getAttribute(`src`)??void 0}set castSrc(e){this.castSrc!=e&&this.setAttribute(`cast-src`,`${e}`)}get castContentType(){return this.getAttribute(`cast-content-type`)??void 0}set castContentType(e){this.setAttribute(`cast-content-type`,`${e}`)}get castStreamType(){return this.getAttribute(`cast-stream-type`)??this.streamType??void 0}set castStreamType(e){this.setAttribute(`cast-stream-type`,`${e}`)}get castCustomData(){return this.#n}set castCustomData(e){let t=typeof e;[`object`,`undefined`].includes(t)?this.#n=e:console.error(`castCustomData must be nullish or an object but value was of type ${t}`)}get readyState(){if(this.#i)switch(this.#i.playerState){case chrome.cast.media.PlayerState.IDLE:return 0;case chrome.cast.media.PlayerState.BUFFERING:return 2;default:return 3}return super.readyState}get paused(){return this.#i?this.#i.isPaused:super.paused}get muted(){return this.#i?this.#i?.isMuted:super.muted}set muted(e){this.#i?(e&&!this.#i.isMuted||!e&&this.#i.isMuted)&&this.#i.controller?.muteOrUnmute():super.muted=e}get volume(){return this.#i?this.#i?.volumeLevel??1:super.volume}set volume(e){this.#i?(this.#i.volumeLevel=+e,this.#i.controller?.setVolumeLevel()):super.volume=e}get duration(){return this.#i&&this.#i?.isMediaLoaded?this.#i?.duration??NaN:super.duration}get currentTime(){return this.#i&&this.#i?.isMediaLoaded?this.#i?.currentTime??0:super.currentTime}set currentTime(e){this.#i?(this.#i.currentTime=e,this.#i.controller?.seek()):super.currentTime=e}},rs=e=>{throw TypeError(e)},is=(e,t,n)=>t.has(e)||rs(`Cannot `+n),as=(e,t,n)=>(is(e,t,`read from private field`),n?n.call(e):t.get(e)),os=(e,t,n)=>t.has(e)?rs(`Cannot add the same private member more than once`):t instanceof WeakSet?t.add(e):t.set(e,n),ss=(e,t,n,r)=>(is(e,t,`write to private field`),r?r.call(e,n):t.set(e,n),n),cs=class{addEventListener(){}removeEventListener(){}dispatchEvent(e){return!0}};if(typeof DocumentFragment>`u`){class e extends cs{}globalThis.DocumentFragment=e}var ls=class extends cs{},us=class extends cs{},ds={get(e){},define(e,t,n){},getName(e){return null},upgrade(e){},whenDefined(e){return Promise.resolve(ls)}},fs,ps=class{constructor(e,t={}){os(this,fs),ss(this,fs,t?.detail)}get detail(){return as(this,fs)}initCustomEvent(){}};fs=new WeakMap;function ms(e,t){return new ls}var hs={document:{createElement:ms},DocumentFragment,customElements:ds,CustomEvent:ps,EventTarget:cs,HTMLElement:ls,HTMLVideoElement:us},gs=typeof window>`u`||globalThis.customElements===void 0,_s=gs?hs:globalThis;gs?hs.document:globalThis.document;var vs,ys=class extends ns(a(ko)){constructor(){super(...arguments),os(this,vs)}get autoplay(){let e=this.getAttribute(`autoplay`);return e===null?!1:e===``||e}set autoplay(e){e!==this.autoplay&&(e?this.setAttribute(`autoplay`,typeof e==`string`?e:``):this.removeAttribute(`autoplay`))}get muxCastCustomData(){return{mux:{playbackId:this.playbackId,minResolution:this.minResolution,maxResolution:this.maxResolution,renditionOrder:this.renditionOrder,customDomain:this.customDomain,tokens:{drm:this.drmToken},envKey:this.envKey,metadata:this.metadata,disableCookies:this.disableCookies,disableTracking:this.disableTracking,beaconCollectionDomain:this.beaconCollectionDomain,startTime:this.startTime,preferCmcd:this.preferCmcd}}}get castCustomData(){return as(this,vs)??this.muxCastCustomData}set castCustomData(e){ss(this,vs,e)}};vs=new WeakMap,_s.customElements.get(`mux-video`)||(_s.customElements.define(`mux-video`,ys),_s.MuxVideoElement=ys);var k={MEDIA_PLAY_REQUEST:`mediaplayrequest`,MEDIA_PAUSE_REQUEST:`mediapauserequest`,MEDIA_MUTE_REQUEST:`mediamuterequest`,MEDIA_UNMUTE_REQUEST:`mediaunmuterequest`,MEDIA_LOOP_REQUEST:`medialooprequest`,MEDIA_VOLUME_REQUEST:`mediavolumerequest`,MEDIA_SEEK_REQUEST:`mediaseekrequest`,MEDIA_AIRPLAY_REQUEST:`mediaairplayrequest`,MEDIA_ENTER_FULLSCREEN_REQUEST:`mediaenterfullscreenrequest`,MEDIA_EXIT_FULLSCREEN_REQUEST:`mediaexitfullscreenrequest`,MEDIA_PREVIEW_REQUEST:`mediapreviewrequest`,MEDIA_ENTER_PIP_REQUEST:`mediaenterpiprequest`,MEDIA_EXIT_PIP_REQUEST:`mediaexitpiprequest`,MEDIA_ENTER_CAST_REQUEST:`mediaentercastrequest`,MEDIA_EXIT_CAST_REQUEST:`mediaexitcastrequest`,MEDIA_SHOW_TEXT_TRACKS_REQUEST:`mediashowtexttracksrequest`,MEDIA_HIDE_TEXT_TRACKS_REQUEST:`mediahidetexttracksrequest`,MEDIA_SHOW_SUBTITLES_REQUEST:`mediashowsubtitlesrequest`,MEDIA_DISABLE_SUBTITLES_REQUEST:`mediadisablesubtitlesrequest`,MEDIA_TOGGLE_SUBTITLES_REQUEST:`mediatogglesubtitlesrequest`,MEDIA_PLAYBACK_RATE_REQUEST:`mediaplaybackraterequest`,MEDIA_RENDITION_REQUEST:`mediarenditionrequest`,MEDIA_AUDIO_TRACK_REQUEST:`mediaaudiotrackrequest`,MEDIA_SEEK_TO_LIVE_REQUEST:`mediaseektoliverequest`,REGISTER_MEDIA_STATE_RECEIVER:`registermediastatereceiver`,UNREGISTER_MEDIA_STATE_RECEIVER:`unregistermediastatereceiver`},A={MEDIA_CHROME_ATTRIBUTES:`mediachromeattributes`,MEDIA_CONTROLLER:`mediacontroller`},bs={MEDIA_AIRPLAY_UNAVAILABLE:`mediaAirplayUnavailable`,MEDIA_AUDIO_TRACK_ENABLED:`mediaAudioTrackEnabled`,MEDIA_AUDIO_TRACK_LIST:`mediaAudioTrackList`,MEDIA_AUDIO_TRACK_UNAVAILABLE:`mediaAudioTrackUnavailable`,MEDIA_BUFFERED:`mediaBuffered`,MEDIA_CAST_UNAVAILABLE:`mediaCastUnavailable`,MEDIA_CHAPTERS_CUES:`mediaChaptersCues`,MEDIA_CURRENT_TIME:`mediaCurrentTime`,MEDIA_DURATION:`mediaDuration`,MEDIA_ENDED:`mediaEnded`,MEDIA_ERROR:`mediaError`,MEDIA_ERROR_CODE:`mediaErrorCode`,MEDIA_ERROR_MESSAGE:`mediaErrorMessage`,MEDIA_FULLSCREEN_UNAVAILABLE:`mediaFullscreenUnavailable`,MEDIA_HAS_PLAYED:`mediaHasPlayed`,MEDIA_HEIGHT:`mediaHeight`,MEDIA_IS_AIRPLAYING:`mediaIsAirplaying`,MEDIA_IS_CASTING:`mediaIsCasting`,MEDIA_IS_FULLSCREEN:`mediaIsFullscreen`,MEDIA_IS_PIP:`mediaIsPip`,MEDIA_LOADING:`mediaLoading`,MEDIA_MUTED:`mediaMuted`,MEDIA_LOOP:`mediaLoop`,MEDIA_PAUSED:`mediaPaused`,MEDIA_PIP_UNAVAILABLE:`mediaPipUnavailable`,MEDIA_PLAYBACK_RATE:`mediaPlaybackRate`,MEDIA_PREVIEW_CHAPTER:`mediaPreviewChapter`,MEDIA_PREVIEW_COORDS:`mediaPreviewCoords`,MEDIA_PREVIEW_IMAGE:`mediaPreviewImage`,MEDIA_PREVIEW_TIME:`mediaPreviewTime`,MEDIA_RENDITION_LIST:`mediaRenditionList`,MEDIA_RENDITION_SELECTED:`mediaRenditionSelected`,MEDIA_RENDITION_UNAVAILABLE:`mediaRenditionUnavailable`,MEDIA_SEEKABLE:`mediaSeekable`,MEDIA_STREAM_TYPE:`mediaStreamType`,MEDIA_SUBTITLES_LIST:`mediaSubtitlesList`,MEDIA_SUBTITLES_SHOWING:`mediaSubtitlesShowing`,MEDIA_TARGET_LIVE_WINDOW:`mediaTargetLiveWindow`,MEDIA_TIME_IS_LIVE:`mediaTimeIsLive`,MEDIA_VOLUME:`mediaVolume`,MEDIA_VOLUME_LEVEL:`mediaVolumeLevel`,MEDIA_VOLUME_UNAVAILABLE:`mediaVolumeUnavailable`,MEDIA_LANG:`mediaLang`,MEDIA_WIDTH:`mediaWidth`},xs=Object.entries(bs),j=xs.reduce((e,[t,n])=>(e[t]=n.toLowerCase(),e),{}),Ss=xs.reduce((e,[t,n])=>(e[t]=n.toLowerCase(),e),{USER_INACTIVE_CHANGE:`userinactivechange`,BREAKPOINTS_CHANGE:`breakpointchange`,BREAKPOINTS_COMPUTED:`breakpointscomputed`});Object.entries(Ss).reduce((e,[t,n])=>{let r=j[t];return r&&(e[n]=r),e},{userinactivechange:`userinactive`});var Cs=Object.entries(j).reduce((e,[t,n])=>{let r=Ss[t];return r&&(e[n]=r),e},{userinactive:`userinactivechange`}),ws={SUBTITLES:`subtitles`,CAPTIONS:`captions`,DESCRIPTIONS:`descriptions`,CHAPTERS:`chapters`,METADATA:`metadata`},Ts={DISABLED:`disabled`,HIDDEN:`hidden`,SHOWING:`showing`},Es={MOUSE:`mouse`,PEN:`pen`,TOUCH:`touch`},Ds={UNAVAILABLE:`unavailable`,UNSUPPORTED:`unsupported`},Os={LIVE:`live`,ON_DEMAND:`on-demand`,UNKNOWN:`unknown`},ks={INLINE:`inline`,FULLSCREEN:`fullscreen`,PICTURE_IN_PICTURE:`picture-in-picture`};function As(e){return e?.map(Ms).join(` `)}function js(e){return e?.split(/\s+/).map(Ns)}function Ms(e){if(e){let{id:t,width:n,height:r}=e;return[t,n,r].filter(e=>e!=null).join(`:`)}}function Ns(e){if(e){let[t,n,r]=e.split(`:`);return{id:t,width:+n,height:+r}}}function Ps(e){return e?.map(Is).join(` `)}function Fs(e){return e?.split(/\s+/).map(Ls)}function Is(e){if(e){let{id:t,kind:n,language:r,label:i}=e;return[t,n,r,i].filter(e=>e!=null).join(`:`)}}function Ls(e){if(e){let[t,n,r,i]=e.split(`:`);return{id:t,kind:n,language:r,label:i}}}function Rs(e){return e.replace(/[-_]([a-z])/g,(e,t)=>t.toUpperCase())}function zs(e){return typeof e==`number`&&!Number.isNaN(e)&&Number.isFinite(e)}function Bs(e){return typeof e==`string`&&!isNaN(e)&&!isNaN(parseFloat(e))}var Vs=e=>new Promise(t=>setTimeout(t,e)),Hs={"&":`&amp;`,"<":`&lt;`,">":`&gt;`,'"':`&quot;`,"'":`&#39;`};function Us(e){return String(e).replace(/[&<>"']/g,e=>Hs[e])}var Ws={en:{"Start airplay":`Start airplay`,"Stop airplay":`Stop airplay`,Audio:`Audio`,Captions:`Captions`,"Enable captions":`Enable captions`,"Disable captions":`Disable captions`,"Start casting":`Start casting`,"Stop casting":`Stop casting`,"Enter fullscreen mode":`Enter fullscreen mode`,"Exit fullscreen mode":`Exit fullscreen mode`,Mute:`Mute`,Unmute:`Unmute`,Loop:`Loop`,"Enter picture in picture mode":`Enter picture in picture mode`,"Exit picture in picture mode":`Exit picture in picture mode`,Play:`Play`,Pause:`Pause`,"Playback rate":`Playback rate`,"Playback rate {playbackRate}":`Playback rate {playbackRate}`,Quality:`Quality`,"Seek backward":`Seek backward`,"Seek forward":`Seek forward`,Settings:`Settings`,Auto:`Auto`,"audio player":`audio player`,"video player":`video player`,volume:`volume`,seek:`seek`,"closed captions":`closed captions`,"current playback rate":`current playback rate`,"playback time":`playback time`,"media loading":`media loading`,settings:`settings`,"audio tracks":`audio tracks`,quality:`quality`,play:`play`,pause:`pause`,mute:`mute`,unmute:`unmute`,"chapter: {chapterName}":`chapter: {chapterName}`,live:`live`,Off:`Off`,"start airplay":`start airplay`,"stop airplay":`stop airplay`,"start casting":`start casting`,"stop casting":`stop casting`,"enter fullscreen mode":`enter fullscreen mode`,"exit fullscreen mode":`exit fullscreen mode`,"enter picture in picture mode":`enter picture in picture mode`,"exit picture in picture mode":`exit picture in picture mode`,"seek to live":`seek to live`,"playing live":`playing live`,"seek back {seekOffset} seconds":`seek back {seekOffset} seconds`,"seek forward {seekOffset} seconds":`seek forward {seekOffset} seconds`,"Network Error":`Network Error`,"Decode Error":`Decode Error`,"Source Not Supported":`Source Not Supported`,"Encryption Error":`Encryption Error`,"A network error caused the media download to fail.":`A network error caused the media download to fail.`,"A media error caused playback to be aborted. The media could be corrupt or your browser does not support this format.":`A media error caused playback to be aborted. The media could be corrupt or your browser does not support this format.`,"An unsupported error occurred. The server or network failed, or your browser does not support this format.":`An unsupported error occurred. The server or network failed, or your browser does not support this format.`,"The media is encrypted and there are no keys to decrypt it.":`The media is encrypted and there are no keys to decrypt it.`,hour:`hour`,hours:`hours`,minute:`minute`,minutes:`minutes`,second:`second`,seconds:`seconds`,"{time} remaining":`{time} remaining`,"{currentTime} of {totalTime}":`{currentTime} of {totalTime}`,"video not loaded, unknown time.":`video not loaded, unknown time.`}},Gs=globalThis.navigator?.language||`en`,Ks=e=>{Gs=e},qs=e=>{let[t]=Gs.split(`-`);return Ws[Gs]?.[e]||Ws[t]?.[e]||Ws.en?.[e]||e},Js=()=>{let[e]=Gs.split(`-`);return Ws[Gs]?Gs:Ws[e]?e:`en`},M=(e,t={})=>qs(e).replace(/\{(\w+)\}/g,(e,n)=>n in t?String(t[n]):`{${n}}`),Ys=[{singular:`hour`,plural:`hours`},{singular:`minute`,plural:`minutes`},{singular:`second`,plural:`seconds`}],Xs=(e,t)=>`${e} ${M(e===1?Ys[t].singular:Ys[t].plural)}`,Zs=e=>{if(!zs(e))return``;let t=Math.abs(e),n=t!==e,r=new Date(0,0,0,0,0,t,0),i=[r.getHours(),r.getMinutes(),r.getSeconds()].map((e,t)=>e&&Xs(e,t)).filter(e=>e).join(`, `);return n?M(`{time} remaining`,{time:i}):t===0?Xs(0,2):i};function Qs(e,t){let n=!1;e<0&&(n=!0,e=0-e),e=e<0?0:e;let r=Math.floor(e%60),i=Math.floor(e/60%60),a=Math.floor(e/3600),o=Math.floor(t/60%60),s=Math.floor(t/3600);return(isNaN(e)||e===1/0)&&(a=i=r=`0`),a=a>0||s>0?a+`:`:``,i=((a||o>=10)&&i<10?`0`+i:i)+`:`,r=r<10?`0`+r:r,(n?`-`:``)+a+i+r}Object.freeze({length:0,start(e){let t=e>>>0;if(t>=this.length)throw new DOMException(`Failed to execute 'start' on 'TimeRanges': The index provided (${t}) is greater than or equal to the maximum bound (${this.length}).`);return 0},end(e){let t=e>>>0;if(t>=this.length)throw new DOMException(`Failed to execute 'end' on 'TimeRanges': The index provided (${t}) is greater than or equal to the maximum bound (${this.length}).`);return 0}});var $s=class{addEventListener(){}removeEventListener(){}dispatchEvent(){return!0}},ec=class extends $s{},tc=class extends ec{constructor(){super(...arguments),this.role=null}},nc=class{observe(){}unobserve(){}disconnect(){}},rc={createElement:function(){return new ic.HTMLElement},createElementNS:function(){return new ic.HTMLElement},addEventListener(){},removeEventListener(){},dispatchEvent(e){return!1}},ic={ResizeObserver:nc,document:rc,Node:ec,Element:tc,HTMLElement:class extends tc{constructor(){super(...arguments),this.innerHTML=``}get content(){return new ic.DocumentFragment}},DocumentFragment:class extends $s{},customElements:{get:function(){},define:function(){},whenDefined:function(){}},localStorage:{getItem(e){return null},setItem(e,t){},removeItem(e){}},CustomEvent:function(){},getComputedStyle:function(){},navigator:{languages:[],get userAgent(){return``}},matchMedia(e){return{matches:!1,media:e}},DOMParser:class{parseFromString(e,t){return{body:{textContent:e}}}}},ac=`global`in globalThis&&(globalThis==null?void 0:globalThis.global)===globalThis||typeof window>`u`||window.customElements===void 0,oc=Object.keys(ic).every(e=>e in globalThis),N=ac&&!oc?ic:globalThis,sc=ac&&!oc?rc:globalThis.document,cc=new WeakMap,lc=e=>{let t=cc.get(e);return t||cc.set(e,t=new Set),t},uc=new N.ResizeObserver(e=>{for(let t of e)for(let e of lc(t.target))e(t)});function dc(e,t){lc(e).add(t),uc.observe(e)}function fc(e,t){let n=lc(e);n.delete(t),n.size||uc.unobserve(e)}function pc(e){let t={};for(let n of e)t[n.name]=n.value;return t}function mc(e){return hc(e)??bc(e,`media-controller`)}function hc(e){let{MEDIA_CONTROLLER:t}=A,n=e.getAttribute(t);if(n)return Sc(e)?.getElementById(n)}var gc=(e,t,n=`.value`)=>{let r=e.querySelector(n);r&&(r.textContent=t)},_c=(e,t)=>{let n=`slot[name="${t}"]`,r=e.shadowRoot.querySelector(n);return r?r.children:[]},vc=(e,t)=>_c(e,t)[0],yc=(e,t)=>!e||!t?!1:e?.contains(t)?!0:yc(e,t.getRootNode().host),bc=(e,t)=>e?e.closest(t)||bc(e.getRootNode().host,t):null;function xc(e=document){let t=e?.activeElement;return t?xc(t.shadowRoot)??t:null}function Sc(e){let t=(e?.getRootNode)?.call(e);return t instanceof ShadowRoot||t instanceof Document?t:null}function Cc(e,{depth:t=3,checkOpacity:n=!0,checkVisibilityCSS:r=!0}={}){if(e.checkVisibility)return e.checkVisibility({checkOpacity:n,checkVisibilityCSS:r});let i=e;for(;i&&t>0;){let e=getComputedStyle(i);if(n&&e.opacity===`0`||r&&e.visibility===`hidden`||e.display===`none`)return!1;i=i.parentElement,t--}return!0}function wc(e,t,n,r){let i=r.x-n.x,a=r.y-n.y,o=i*i+a*a;if(o===0)return 0;let s=((e-n.x)*i+(t-n.y)*a)/o;return Math.max(0,Math.min(1,s))}function Tc(e,t){return Ec(e,e=>e===t)||Dc(e,t)}function Ec(e,t){let n;for(n of e.querySelectorAll(`style:not([media])`)??[]){let e;try{e=n.sheet?.cssRules}catch{continue}for(let n of e??[])if(t(n.selectorText))return n}}function Dc(e,t){let n=e.querySelectorAll(`style:not([media])`)??[],r=n?.[n.length-1];if(!r?.sheet)return console.warn(`Media Chrome: No style sheet found on style tag of`,e),{style:{setProperty:()=>{},removeProperty:()=>``,getPropertyValue:()=>``}};let i=r?.sheet.insertRule(`${t}{}`,r.sheet.cssRules.length);return r.sheet.cssRules?.[i]}function P(e,t,n=NaN){let r=e.getAttribute(t);return r==null?n:+r}function F(e,t,n){let r=+n;n==null||Number.isNaN(r)?e.hasAttribute(t)&&e.removeAttribute(t):P(e,t,void 0)!==r&&e.setAttribute(t,`${r}`)}function I(e,t){return e.hasAttribute(t)}function L(e,t,n){n==null?e.hasAttribute(t)&&e.removeAttribute(t):I(e,t)!=n&&e.toggleAttribute(t,n)}function R(e,t,n=null){return e.getAttribute(t)??n}function z(e,t,n){if(n==null){e.hasAttribute(t)&&e.removeAttribute(t);return}let r=`${n}`;R(e,t,void 0)!==r&&e.setAttribute(t,r)}var Oc=(e,t,n)=>{if(!t.has(e))throw TypeError(`Cannot `+n)},kc=(e,t,n)=>(Oc(e,t,`read from private field`),n?n.call(e):t.get(e)),Ac=(e,t,n)=>{if(t.has(e))throw TypeError(`Cannot add the same private member more than once`);t instanceof WeakSet?t.add(e):t.set(e,n)},jc=(e,t,n,r)=>(Oc(e,t,`write to private field`),r?r.call(e,n):t.set(e,n),n),Mc;function Nc(e){return`
    <style>
      :host {
        display: var(--media-control-display, var(--media-gesture-receiver-display, inline-block));
        box-sizing: border-box;
      }
    </style>
  `}var Pc=class extends N.HTMLElement{constructor(){if(super(),Ac(this,Mc,void 0),!this.shadowRoot){this.attachShadow(this.constructor.shadowRootOptions);let e=pc(this.attributes);this.shadowRoot.innerHTML=this.constructor.getTemplateHTML(e)}}static get observedAttributes(){return[A.MEDIA_CONTROLLER,j.MEDIA_PAUSED]}attributeChangedCallback(e,t,n){var r,i,a,o;e===A.MEDIA_CONTROLLER&&(t&&((i=(r=kc(this,Mc))?.unassociateElement)==null||i.call(r,this),jc(this,Mc,null)),n&&this.isConnected&&(jc(this,Mc,this.getRootNode()?.getElementById(n)),(o=(a=kc(this,Mc))?.associateElement)==null||o.call(a,this)))}connectedCallback(){var e,t;this.tabIndex=-1,this.setAttribute(`aria-hidden`,`true`),jc(this,Mc,Fc(this)),this.getAttribute(A.MEDIA_CONTROLLER)&&((t=(e=kc(this,Mc))?.associateElement)==null||t.call(e,this)),kc(this,Mc)&&(kc(this,Mc).addEventListener(`pointerdown`,this),kc(this,Mc).addEventListener(`click`,this),kc(this,Mc).hasAttribute(`tabindex`)||(kc(this,Mc).tabIndex=0))}disconnectedCallback(){var e,t,n,r;this.getAttribute(A.MEDIA_CONTROLLER)&&((t=(e=kc(this,Mc))?.unassociateElement)==null||t.call(e,this)),(n=kc(this,Mc))==null||n.removeEventListener(`pointerdown`,this),(r=kc(this,Mc))==null||r.removeEventListener(`click`,this),jc(this,Mc,null)}handleEvent(e){let t=e.composedPath()?.[0];if([`video`,`media-controller`].includes(t?.localName)){if(e.type===`pointerdown`)this._pointerType=e.pointerType;else if(e.type===`click`){let{clientX:t,clientY:n}=e,{left:r,top:i,width:a,height:o}=this.getBoundingClientRect(),s=t-r,c=n-i;if(s<0||c<0||s>a||c>o||a===0&&o===0)return;let l=this._pointerType||`mouse`;if(this._pointerType=void 0,l===Es.TOUCH){this.handleTap(e);return}if(l===Es.MOUSE||l===Es.PEN){this.handleMouseClick(e);return}}}}get mediaPaused(){return I(this,j.MEDIA_PAUSED)}set mediaPaused(e){L(this,j.MEDIA_PAUSED,e)}handleTap(e){}handleMouseClick(e){let t=this.mediaPaused?k.MEDIA_PLAY_REQUEST:k.MEDIA_PAUSE_REQUEST;this.dispatchEvent(new N.CustomEvent(t,{composed:!0,bubbles:!0}))}};Mc=new WeakMap,Pc.shadowRootOptions={mode:`open`},Pc.getTemplateHTML=Nc;function Fc(e){let t=e.getAttribute(A.MEDIA_CONTROLLER);return t?e.getRootNode()?.getElementById(t):bc(e,`media-controller`)}N.customElements.get(`media-gesture-receiver`)||N.customElements.define(`media-gesture-receiver`,Pc);var Ic=Pc,Lc=(e,t,n)=>{if(!t.has(e))throw TypeError(`Cannot `+n)},Rc=(e,t,n)=>(Lc(e,t,`read from private field`),n?n.call(e):t.get(e)),zc=(e,t,n)=>{if(t.has(e))throw TypeError(`Cannot add the same private member more than once`);t instanceof WeakSet?t.add(e):t.set(e,n)},Bc=(e,t,n,r)=>(Lc(e,t,`write to private field`),r?r.call(e,n):t.set(e,n),n),Vc=(e,t,n)=>(Lc(e,t,`access private method`),n),Hc,Uc,Wc,Gc,Kc,qc,Jc,Yc,Xc,Zc,Qc,$c,el,tl,nl,rl,il,al,ol,sl,B={AUDIO:`audio`,AUTOHIDE:`autohide`,BREAKPOINTS:`breakpoints`,GESTURES_DISABLED:`gesturesdisabled`,KEYBOARD_CONTROL:`keyboardcontrol`,NO_AUTOHIDE:`noautohide`,USER_INACTIVE:`userinactive`,AUTOHIDE_OVER_CONTROLS:`autohideovercontrols`};function cl(e){return`
    <style>
      
      :host([${j.MEDIA_IS_FULLSCREEN}]) ::slotted([slot=media]) {
        outline: none;
      }

      :host {
        box-sizing: border-box;
        position: relative;
        display: inline-block;
        line-height: 0;
        background-color: var(--media-background-color, #000);
        overflow: hidden;
      }

      :host(:not([${B.AUDIO}])) [part~=layer]:not([part~=media-layer]) {
        position: absolute;
        top: 0;
        left: 0;
        bottom: 0;
        right: 0;
        display: flex;
        flex-flow: column nowrap;
        align-items: start;
        pointer-events: none;
        background: none;
      }

      slot[name=media] {
        display: var(--media-slot-display, contents);
      }

      
      :host([${B.AUDIO}]) slot[name=media] {
        display: var(--media-slot-display, none);
      }

      
      :host([${B.AUDIO}]) [part~=layer][part~=gesture-layer] {
        height: 0;
        display: block;
      }

      
      :host(:not([${B.AUDIO}])[${B.GESTURES_DISABLED}]) ::slotted([slot=gestures-chrome]),
          :host(:not([${B.AUDIO}])[${B.GESTURES_DISABLED}]) media-gesture-receiver[slot=gestures-chrome] {
        display: none;
      }

      
      ::slotted(:not([slot=media]):not([slot=poster]):not(media-loading-indicator):not([role=dialog]):not([hidden])) {
        pointer-events: auto;
      }

      :host(:not([${B.AUDIO}])) *[part~=layer][part~=centered-layer] {
        align-items: center;
        justify-content: center;
      }

      :host(:not([${B.AUDIO}])) ::slotted(media-gesture-receiver[slot=gestures-chrome]),
      :host(:not([${B.AUDIO}])) media-gesture-receiver[slot=gestures-chrome] {
        align-self: stretch;
        flex-grow: 1;
      }

      slot[name=middle-chrome] {
        display: inline;
        flex-grow: 1;
        pointer-events: none;
        background: none;
      }

      
      ::slotted([slot=media]),
      ::slotted([slot=poster]) {
        width: 100%;
        height: 100%;
      }

      
      :host(:not([${B.AUDIO}])) .spacer {
        flex-grow: 1;
      }

      
      :host(:-webkit-full-screen) {
        
        width: 100% !important;
        height: 100% !important;
      }

      
      ::slotted(:not([slot=media]):not([slot=poster]):not([${B.NO_AUTOHIDE}]):not([hidden]):not([role=dialog])) {
        opacity: 1;
        transition: var(--media-control-transition-in, opacity 0.25s);
      }

      
      :host([${B.USER_INACTIVE}]:not([${j.MEDIA_PAUSED}]):not([${j.MEDIA_IS_AIRPLAYING}]):not([${j.MEDIA_IS_CASTING}]):not([${B.AUDIO}])) ::slotted(:not([slot=media]):not([slot=poster]):not([${B.NO_AUTOHIDE}]):not([role=dialog])) {
        opacity: 0;
        transition: var(--media-control-transition-out, opacity 1s);
      }

      :host([${B.USER_INACTIVE}]:not([${B.NO_AUTOHIDE}]):not([${j.MEDIA_PAUSED}]):not([${j.MEDIA_IS_CASTING}]):not([${B.AUDIO}])) ::slotted([slot=media]) {
        cursor: none;
      }

      :host([${B.USER_INACTIVE}][${B.AUTOHIDE_OVER_CONTROLS}]:not([${B.NO_AUTOHIDE}]):not([${j.MEDIA_PAUSED}]):not([${j.MEDIA_IS_CASTING}]):not([${B.AUDIO}])) * {
        --media-cursor: none;
        cursor: none;
      }


      ::slotted(media-control-bar)  {
        align-self: stretch;
      }

      
      
      :host(:not([${B.AUDIO}])[${j.MEDIA_HAS_PLAYED}]) slot[name=poster],
      :host(:not([${B.AUDIO}])[${j.MEDIA_STREAM_TYPE}="${Os.ON_DEMAND}"][${j.MEDIA_CURRENT_TIME}]:not([${j.MEDIA_CURRENT_TIME}="0"])) slot[name=poster] {
        display: none;
      }

      ::slotted([role=dialog]) {
        width: 100%;
        height: 100%;
        align-self: center;
      }

      ::slotted([role=menu]) {
        align-self: end;
      }
    </style>

    <slot name="media" part="layer media-layer"></slot>
    <slot name="poster" part="layer poster-layer"></slot>
    <slot name="gestures-chrome" part="layer gesture-layer">
      <media-gesture-receiver slot="gestures-chrome">
        <template shadowrootmode="${Ic.shadowRootOptions.mode}">
          ${Ic.getTemplateHTML({})}
        </template>
      </media-gesture-receiver>
    </slot>
    <span part="layer vertical-layer">
      <slot name="top-chrome" part="top chrome"></slot>
      <slot name="middle-chrome" part="middle chrome"></slot>
      <slot name="centered-chrome" part="layer centered-layer center centered chrome"></slot>
      
      <slot part="bottom chrome"></slot>
    </span>
    <slot name="dialog" part="layer dialog-layer"></slot>
  `}var ll=Object.values(j),ul=`sm:384 md:576 lg:768 xl:960`;function dl(e){fl(e.target,e.contentRect.width)}function fl(e,t){if(!e.isConnected)return;let n=pl(e.getAttribute(B.BREAKPOINTS)??ul),r=ml(n,t),i=!1;if(Object.keys(n).forEach(t=>{r.includes(t)?e.hasAttribute(`breakpoint${t}`)||(e.setAttribute(`breakpoint${t}`,``),i=!0):e.hasAttribute(`breakpoint${t}`)&&(e.removeAttribute(`breakpoint${t}`),i=!0)}),i){let t=new CustomEvent(Ss.BREAKPOINTS_CHANGE,{detail:r});e.dispatchEvent(t)}e.breakpointsComputed||(e.breakpointsComputed=!0,e.dispatchEvent(new CustomEvent(Ss.BREAKPOINTS_COMPUTED,{bubbles:!0,composed:!0})))}function pl(e){let t=e.split(/\s+/);return Object.fromEntries(t.map(e=>e.split(`:`)))}function ml(e,t){return Object.keys(e).filter(n=>t>=parseInt(e[n]))}var hl=class extends N.HTMLElement{constructor(){if(super(),zc(this,Xc),zc(this,Qc),zc(this,el),zc(this,nl),zc(this,il),zc(this,Hc,void 0),zc(this,Uc,0),zc(this,Wc,null),zc(this,Gc,null),zc(this,Kc,void 0),this.breakpointsComputed=!1,zc(this,qc,e=>{let t=this.media;for(let n of e){if(n.type!==`childList`)continue;let e=n.removedNodes;for(let r of e){if(r.slot!=`media`||n.target!=this)continue;let e=n.previousSibling&&n.previousSibling.previousElementSibling;if(!e||!t)this.mediaUnsetCallback(r);else{let t=e.slot!==`media`;for(;(e=e.previousSibling)!==null;)e.slot==`media`&&(t=!1);t&&this.mediaUnsetCallback(r)}}if(t)for(let e of n.addedNodes)e===t&&this.handleMediaUpdated(t)}}),zc(this,Jc,!1),zc(this,Yc,e=>{Rc(this,Jc)||(setTimeout(()=>{dl(e),Bc(this,Jc,!1)},0),Bc(this,Jc,!0))}),zc(this,ol,void 0),zc(this,sl,()=>{Rc(this,ol).assignedElements({flatten:!0}).length?this.handleMediaUpdated(this.media):Rc(this,Wc)&&this.mediaUnsetCallback(Rc(this,Wc))}),!this.shadowRoot){this.attachShadow(this.constructor.shadowRootOptions);let e=pc(this.attributes),t=this.constructor.getTemplateHTML(e);this.shadowRoot.setHTMLUnsafe?this.shadowRoot.setHTMLUnsafe(t):this.shadowRoot.innerHTML=t}Bc(this,Hc,new MutationObserver(Rc(this,qc)))}static get observedAttributes(){return[B.AUTOHIDE,B.GESTURES_DISABLED].concat(ll).filter(e=>![j.MEDIA_RENDITION_LIST,j.MEDIA_AUDIO_TRACK_LIST,j.MEDIA_CHAPTERS_CUES,j.MEDIA_WIDTH,j.MEDIA_HEIGHT,j.MEDIA_ERROR,j.MEDIA_ERROR_MESSAGE].includes(e))}attributeChangedCallback(e,t,n){e.toLowerCase()==B.AUTOHIDE&&(this.autohide=n)}get media(){let e=this.querySelector(`:scope > [slot=media]`);return e?.nodeName==`SLOT`&&(e=e.assignedElements({flatten:!0})[0]),e}async handleMediaUpdated(e){e&&(Bc(this,Wc,e),e.localName.includes(`-`)&&await N.customElements.whenDefined(e.localName),this.mediaSetCallback(e))}connectedCallback(){var e;Rc(this,Hc).observe(this,{childList:!0,subtree:!0}),dc(this,Rc(this,Yc));let t=this.getAttribute(B.AUDIO)==null?M(`video player`):M(`audio player`);this.setAttribute(`role`,`region`),this.setAttribute(`aria-label`,t),this.handleMediaUpdated(this.media),this.setAttribute(B.USER_INACTIVE,``),fl(this,this.getBoundingClientRect().width);let n=this.querySelector(`:scope > slot[slot=media]`);n&&(Bc(this,ol,n),Rc(this,ol).addEventListener(`slotchange`,Rc(this,sl))),this.addEventListener(`pointerdown`,this),this.addEventListener(`pointermove`,this),this.addEventListener(`pointerup`,this),this.addEventListener(`mouseleave`,this),this.addEventListener(`keyup`,this),(e=N.window)==null||e.addEventListener(`mouseup`,this)}disconnectedCallback(){var e;fc(this,Rc(this,Yc)),clearTimeout(Rc(this,Gc)),Rc(this,Hc).disconnect(),this.media&&this.mediaUnsetCallback(this.media),(e=N.window)==null||e.removeEventListener(`mouseup`,this),this.removeEventListener(`pointerdown`,this),this.removeEventListener(`pointermove`,this),this.removeEventListener(`pointerup`,this),this.removeEventListener(`mouseleave`,this),this.removeEventListener(`keyup`,this),Rc(this,ol)&&(Rc(this,ol).removeEventListener(`slotchange`,Rc(this,sl)),Bc(this,ol,null)),Bc(this,Jc,!1)}mediaSetCallback(e){}mediaUnsetCallback(e){Bc(this,Wc,null)}handleEvent(e){switch(e.type){case`pointerdown`:Bc(this,Uc,e.timeStamp);break;case`pointermove`:Vc(this,Xc,Zc).call(this,e);break;case`pointerup`:Vc(this,Qc,$c).call(this,e);break;case`mouseleave`:Vc(this,el,tl).call(this);break;case`mouseup`:this.removeAttribute(B.KEYBOARD_CONTROL);break;case`keyup`:Vc(this,il,al).call(this),this.setAttribute(B.KEYBOARD_CONTROL,``)}}set autohide(e){let t=Number(e);Bc(this,Kc,isNaN(t)?0:t)}get autohide(){return(Rc(this,Kc)===void 0?2:Rc(this,Kc)).toString()}get breakpoints(){return R(this,B.BREAKPOINTS)}set breakpoints(e){z(this,B.BREAKPOINTS,e)}get audio(){return I(this,B.AUDIO)}set audio(e){L(this,B.AUDIO,e)}get gesturesDisabled(){return I(this,B.GESTURES_DISABLED)}set gesturesDisabled(e){L(this,B.GESTURES_DISABLED,e)}get keyboardControl(){return I(this,B.KEYBOARD_CONTROL)}set keyboardControl(e){L(this,B.KEYBOARD_CONTROL,e)}get noAutohide(){return I(this,B.NO_AUTOHIDE)}set noAutohide(e){L(this,B.NO_AUTOHIDE,e)}get autohideOverControls(){return I(this,B.AUTOHIDE_OVER_CONTROLS)}set autohideOverControls(e){L(this,B.AUTOHIDE_OVER_CONTROLS,e)}get userInteractive(){return I(this,B.USER_INACTIVE)}set userInteractive(e){L(this,B.USER_INACTIVE,e)}};Hc=new WeakMap,Uc=new WeakMap,Wc=new WeakMap,Gc=new WeakMap,Kc=new WeakMap,qc=new WeakMap,Jc=new WeakMap,Yc=new WeakMap,Xc=new WeakSet,Zc=function(e){if(e.pointerType!==`mouse`&&e.timeStamp-Rc(this,Uc)<250)return;Vc(this,nl,rl).call(this),clearTimeout(Rc(this,Gc));let t=this.hasAttribute(B.AUTOHIDE_OVER_CONTROLS);([this,this.media].includes(e.target)||t)&&Vc(this,il,al).call(this)},Qc=new WeakSet,$c=function(e){if(e.pointerType===`touch`){let t=!this.hasAttribute(B.USER_INACTIVE);[this,this.media].includes(e.target)&&t?Vc(this,el,tl).call(this):Vc(this,il,al).call(this)}else e.composedPath().some(e=>[`media-play-button`,`media-fullscreen-button`].includes(e?.localName))&&Vc(this,il,al).call(this)},el=new WeakSet,tl=function(){if(Rc(this,Kc)<0||this.hasAttribute(B.USER_INACTIVE))return;this.setAttribute(B.USER_INACTIVE,``);let e=new N.CustomEvent(Ss.USER_INACTIVE_CHANGE,{composed:!0,bubbles:!0,detail:!0});this.dispatchEvent(e)},nl=new WeakSet,rl=function(){if(!this.hasAttribute(B.USER_INACTIVE))return;this.removeAttribute(B.USER_INACTIVE);let e=new N.CustomEvent(Ss.USER_INACTIVE_CHANGE,{composed:!0,bubbles:!0,detail:!1});this.dispatchEvent(e)},il=new WeakSet,al=function(){Vc(this,nl,rl).call(this),clearTimeout(Rc(this,Gc));let e=parseInt(this.autohide);e<0||Bc(this,Gc,setTimeout(()=>{Vc(this,el,tl).call(this)},e*1e3))},ol=new WeakMap,sl=new WeakMap,hl.shadowRootOptions={mode:`open`},hl.getTemplateHTML=cl,N.customElements.get(`media-container`)||N.customElements.define(`media-container`,hl);var gl=(e,t,n)=>{if(!t.has(e))throw TypeError(`Cannot `+n)},_l=(e,t,n)=>(gl(e,t,`read from private field`),n?n.call(e):t.get(e)),vl=(e,t,n)=>{if(t.has(e))throw TypeError(`Cannot add the same private member more than once`);t instanceof WeakSet?t.add(e):t.set(e,n)},yl=(e,t,n,r)=>(gl(e,t,`write to private field`),r?r.call(e,n):t.set(e,n),n),bl=(e,t,n)=>(gl(e,t,`access private method`),n),xl,Sl,Cl,wl,Tl,El,Dl,Ol,kl,Al,jl,Ml,Nl,Pl,Fl;function Il(e){return`
    <style>
      :host {
        font: var(--media-font,
          var(--media-font-weight, normal)
          var(--media-font-size, 14px) /
          var(--media-text-content-height, var(--media-control-height, 24px))
          var(--media-font-family, helvetica neue, segoe ui, roboto, arial, sans-serif));
        color: var(--media-text-color, var(--media-primary-color, rgb(238 238 238)));
        display: var(--media-dialog-display, inline-flex);
        justify-content: center;
        align-items: center;
        
        transition-behavior: allow-discrete;
        visibility: hidden;
        opacity: 0;
        transform: translateY(2px) scale(.99);
        pointer-events: none;
      }

      :host([open]) {
        transition: display .2s, visibility 0s, opacity .2s ease-out, transform .15s ease-out;
        visibility: visible;
        opacity: 1;
        transform: translateY(0) scale(1);
        pointer-events: auto;
      }

      #content {
        display: flex;
        position: relative;
        box-sizing: border-box;
        width: min(320px, 100%);
        word-wrap: break-word;
        max-height: 100%;
        overflow: auto;
        text-align: center;
        line-height: 1.4;
      }
    </style>
    ${this.getSlotTemplateHTML(e)}
  `}function Ll(e){return`
    <slot id="content"></slot>
  `}var Rl={OPEN:`open`,ANCHOR:`anchor`},zl=class extends N.HTMLElement{constructor(){super(),vl(this,wl),vl(this,El),vl(this,Ol),vl(this,Al),vl(this,Ml),vl(this,Pl),vl(this,xl,!1),vl(this,Sl,null),vl(this,Cl,null)}static get observedAttributes(){return[Rl.OPEN,Rl.ANCHOR]}get open(){return I(this,Rl.OPEN)}set open(e){L(this,Rl.OPEN,e)}handleEvent(e){switch(e.type){case`invoke`:bl(this,Al,jl).call(this,e);break;case`focusout`:bl(this,Ml,Nl).call(this,e);break;case`keydown`:bl(this,Pl,Fl).call(this,e)}}connectedCallback(){bl(this,wl,Tl).call(this),this.role||=`dialog`,this.addEventListener(`invoke`,this),this.addEventListener(`focusout`,this),this.addEventListener(`keydown`,this)}disconnectedCallback(){this.removeEventListener(`invoke`,this),this.removeEventListener(`focusout`,this),this.removeEventListener(`keydown`,this)}attributeChangedCallback(e,t,n){bl(this,wl,Tl).call(this),e===Rl.OPEN&&n!==t&&(this.open?bl(this,El,Dl).call(this):bl(this,Ol,kl).call(this))}focus(){yl(this,Sl,xc());let e=!this.dispatchEvent(new Event(`focus`,{composed:!0,cancelable:!0})),t=!this.dispatchEvent(new Event(`focusin`,{composed:!0,bubbles:!0,cancelable:!0}));e||t||this.querySelector(`[autofocus], [tabindex]:not([tabindex="-1"]), [role="menu"]`)?.focus()}get keysUsed(){return[`Escape`,`Tab`]}};xl=new WeakMap,Sl=new WeakMap,Cl=new WeakMap,wl=new WeakSet,Tl=function(){if(!_l(this,xl)&&(yl(this,xl,!0),!this.shadowRoot)){this.attachShadow(this.constructor.shadowRootOptions);let e=pc(this.attributes);this.shadowRoot.innerHTML=this.constructor.getTemplateHTML(e),queueMicrotask(()=>{let{style:e}=Tc(this.shadowRoot,`:host`);e.setProperty(`transition`,`display .15s, visibility .15s, opacity .15s ease-in, transform .15s ease-in`)})}},El=new WeakSet,Dl=function(){var e;(e=_l(this,Cl))==null||e.setAttribute(`aria-expanded`,`true`),this.dispatchEvent(new Event(`open`,{composed:!0,bubbles:!0})),this.addEventListener(`transitionend`,()=>this.focus(),{once:!0})},Ol=new WeakSet,kl=function(){var e;(e=_l(this,Cl))==null||e.setAttribute(`aria-expanded`,`false`),this.dispatchEvent(new Event(`close`,{composed:!0,bubbles:!0}))},Al=new WeakSet,jl=function(e){yl(this,Cl,e.relatedTarget),yc(this,e.relatedTarget)||(this.open=!this.open)},Ml=new WeakSet,Nl=function(e){var t;yc(this,e.relatedTarget)||((t=_l(this,Sl))==null||t.focus(),_l(this,Cl)&&_l(this,Cl)!==e.relatedTarget&&this.open&&(this.open=!1))},Pl=new WeakSet,Fl=function(e){var t,n,r,i,a;let{key:o,ctrlKey:s,altKey:c,metaKey:l}=e;s||c||l||this.keysUsed.includes(o)&&(e.preventDefault(),e.stopPropagation(),o===`Tab`?(e.shiftKey?(n=(t=this.previousElementSibling)?.focus)==null||n.call(t):(i=(r=this.nextElementSibling)?.focus)==null||i.call(r),this.blur()):o===`Escape`&&((a=_l(this,Sl))==null||a.focus(),this.open=!1))},zl.shadowRootOptions={mode:`open`},zl.getTemplateHTML=Il,zl.getSlotTemplateHTML=Ll,N.customElements.get(`media-chrome-dialog`)||N.customElements.define(`media-chrome-dialog`,zl);var Bl=(e,t,n)=>{if(!t.has(e))throw TypeError(`Cannot `+n)},Vl=(e,t,n)=>(Bl(e,t,`read from private field`),n?n.call(e):t.get(e)),Hl=(e,t,n)=>{if(t.has(e))throw TypeError(`Cannot add the same private member more than once`);t instanceof WeakSet?t.add(e):t.set(e,n)},Ul,Wl,Gl={HOTKEYS:`hotkeys`},Kl=[{keys:[{key:` `,label:`Space`},{key:`k`}],description:`Toggle Playback`},{keys:[{key:`m`}],description:`Toggle mute`},{keys:[{key:`f`}],description:`Toggle fullscreen`},{keys:[{key:`c`}],description:`Toggle captions or subtitles, if available`},{keys:[{key:`p`}],description:`Toggle Picture in Picture`},{keys:[{key:`ArrowLeft`,label:`←`},{key:`j`}],description:`Seek back 10s`},{keys:[{key:`ArrowRight`,label:`→`},{key:`l`}],description:`Seek forward 10s`},{keys:[{key:`ArrowUp`,label:`↑`}],description:`Turn volume up`},{keys:[{key:`ArrowDown`,label:`↓`}],description:`Turn volume down`},{keys:[{key:`<`,label:`< (SHIFT+,)`}],description:`Decrease playback rate`},{keys:[{key:`>`,label:`> (SHIFT+.)`}],description:`Increase playback rate`},{keys:[{key:`shift+/`,label:`SHIFT+/`}],description:`Show keyboard shortcuts`}];function ql(e){return e===` `?`nospace`:`no${e.toLowerCase()}`}function Jl(e){let t=new Set(e?.split(/\s+/));return Kl.map(({keys:e,description:n})=>({keys:e.filter(({key:e})=>!t.has(ql(e))),description:n})).filter(({keys:e})=>e.length)}function Yl(e){return`
    <style>
      :host {
        position: fixed;
        top: 0;
        left: 0;
        z-index: 9999;
        background: rgb(20 20 30 / .8);
        backdrop-filter: blur(10px);
      }

      #content {
        display: block;
        width: clamp(400px, 40vw, 700px);
        max-width: 90vw;
        text-align: left;
      }

      h2 {
        margin: 0 0 1.5rem 0;
        font-size: 1.5rem;
        font-weight: 500;
        text-align: center;
      }

      .shortcuts-table {
        width: 100%;
        border-collapse: collapse;
      }

      .shortcuts-table tr {
        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
      }

      .shortcuts-table tr:last-child {
        border-bottom: none;
      }

      .shortcuts-table td {
        padding: 0.75rem 0.5rem;
      }

      .shortcuts-table td:first-child {
        text-align: right;
        padding-right: 1rem;
        width: 40%;
        min-width: 120px;
      }

      .shortcuts-table td:last-child {
        padding-left: 1rem;
      }

      .key {
        display: inline-block;
        background: rgba(255, 255, 255, 0.15);
        border: 1px solid rgba(255, 255, 255, 0.2);
        border-radius: 4px;
        padding: 0.25rem 0.5rem;
        font-family: 'Courier New', monospace;
        font-size: 0.9rem;
        font-weight: 500;
        min-width: 1.5rem;
        text-align: center;
        margin: 0 0.2rem;
      }

      .description {
        color: rgba(255, 255, 255, 0.9);
        font-size: 0.95rem;
      }

      .key-combo {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 0.3rem;
      }

      .key-separator {
        color: rgba(255, 255, 255, 0.5);
        font-size: 0.9rem;
      }
    </style>
    <slot id="content">
      ${Xl(e[Gl.HOTKEYS])}
    </slot>
  `}function Xl(e){return`
    <h2>Keyboard Shortcuts</h2>
    <table class="shortcuts-table">${Jl(e).map(({keys:e,description:t})=>`
        <tr>
          <td>
            <div class="key-combo">${e.map(({key:e,label:t=e},n)=>n>0?`<span class="key-separator">or</span><span class="key">${t}</span>`:`<span class="key">${t}</span>`).join(``)}</div>
          </td>
          <td class="description">${t}</td>
        </tr>
      `).join(``)}</table>
  `}var Zl=class extends zl{constructor(){super(...arguments),Hl(this,Ul,e=>{if(!this.open)return;let t=this.shadowRoot?.querySelector(`#content`);if(!t)return;let n=e.composedPath(),r=n[0]===this||n.includes(this),i=n.includes(t);r&&!i&&(this.open=!1)}),Hl(this,Wl,e=>{if(!this.open)return;let t=e.shiftKey&&(e.key===`/`||e.key===`?`);e.key!==`Escape`&&!t||e.ctrlKey||e.altKey||e.metaKey||(this.open=!1,e.preventDefault(),e.stopPropagation())})}static get observedAttributes(){return[...super.observedAttributes,Gl.HOTKEYS]}get hotkeys(){return R(this,Gl.HOTKEYS)??void 0}set hotkeys(e){z(this,Gl.HOTKEYS,e)}connectedCallback(){super.connectedCallback(),this.open&&(this.addEventListener(`click`,Vl(this,Ul)),document.addEventListener(`keydown`,Vl(this,Wl)))}disconnectedCallback(){this.removeEventListener(`click`,Vl(this,Ul)),document.removeEventListener(`keydown`,Vl(this,Wl))}attributeChangedCallback(e,t,n){if(super.attributeChangedCallback(e,t,n),e===`open`)this.open?(this.addEventListener(`click`,Vl(this,Ul)),document.addEventListener(`keydown`,Vl(this,Wl))):(this.removeEventListener(`click`,Vl(this,Ul)),document.removeEventListener(`keydown`,Vl(this,Wl)));else if(e===Gl.HOTKEYS&&n!==t){let e=this.shadowRoot?.querySelector(`#content`);e&&(e.innerHTML=Xl(n))}}};Ul=new WeakMap,Wl=new WeakMap,Zl.getSlotTemplateHTML=Yl,N.customElements.get(`media-keyboard-shortcuts-dialog`)||N.customElements.define(`media-keyboard-shortcuts-dialog`,Zl);var Ql=(e,t,n)=>{if(!t.has(e))throw TypeError(`Cannot `+n)},$l=(e,t,n)=>(Ql(e,t,`read from private field`),n?n.call(e):t.get(e)),eu=(e,t,n)=>{if(t.has(e))throw TypeError(`Cannot add the same private member more than once`);t instanceof WeakSet?t.add(e):t.set(e,n)},tu=(e,t,n,r)=>(Ql(e,t,`write to private field`),r?r.call(e,n):t.set(e,n),n),nu,ru,iu,au,ou,su,cu=class{constructor(e,t,{defaultValue:n}={defaultValue:void 0}){eu(this,ou),eu(this,nu,void 0),eu(this,ru,void 0),eu(this,iu,void 0),eu(this,au,new Set),tu(this,nu,e),tu(this,ru,t),tu(this,iu,new Set(n))}[Symbol.iterator](){return $l(this,ou,su).values()}get length(){return $l(this,ou,su).size}get value(){return[...$l(this,ou,su)].join(` `)??``}set value(e){e!==this.value&&(tu(this,au,new Set),this.add(...e?.split(` `)??[]))}toString(){return this.value}item(e){return[...$l(this,ou,su)][e]}values(){return $l(this,ou,su).values()}forEach(e,t){$l(this,ou,su).forEach(e,t)}add(...e){var t;e.forEach(e=>$l(this,au).add(e)),this.value===``&&!$l(this,nu)?.hasAttribute(`${$l(this,ru)}`)||(t=$l(this,nu))==null||t.setAttribute(`${$l(this,ru)}`,`${this.value}`)}remove(...e){var t;e.forEach(e=>$l(this,au).delete(e)),(t=$l(this,nu))==null||t.setAttribute(`${$l(this,ru)}`,`${this.value}`)}contains(e){return $l(this,ou,su).has(e)}toggle(e,t){return t===void 0?this.contains(e)?(this.remove(e),!1):(this.add(e),!0):t?(this.add(e),!0):(this.remove(e),!1)}replace(e,t){return this.remove(e),this.add(t),e===t}};nu=new WeakMap,ru=new WeakMap,iu=new WeakMap,au=new WeakMap,ou=new WeakSet,su=function(){return $l(this,au).size?$l(this,au):$l(this,iu)};var lu=(e=``)=>e.split(/\s+/),uu=(e=``)=>{let[t,n,r]=e.split(`:`),i=r?decodeURIComponent(r):void 0;return{kind:t===`cc`?ws.CAPTIONS:ws.SUBTITLES,language:n,label:i}},du=(e=``,t={})=>lu(e).map(e=>{let n=uu(e);return{...t,...n}}),fu=e=>e?Array.isArray(e)?e.map(e=>typeof e==`string`?uu(e):e):typeof e==`string`?du(e):[e]:[],pu=({kind:e,label:t,language:n}={kind:`subtitles`})=>t?`${e===`captions`?`cc`:`sb`}:${n}:${encodeURIComponent(t)}`:n,mu=(e=[])=>Array.prototype.map.call(e,pu).join(` `),hu=(e,t)=>n=>n[e]===t,gu=e=>{let t=Object.entries(e).map(([e,t])=>hu(e,t));return e=>t.every(t=>t(e))},_u=(e,t=[],n=[])=>{let r=fu(n).map(gu);Array.from(t).filter(e=>r.some(t=>t(e))).forEach(t=>{t.mode=e})},vu=(e,t=()=>!0)=>{if(!e?.textTracks)return[];let n=typeof t==`function`?t:gu(t);return Array.from(e.textTracks).filter(n)},yu=e=>!!e.mediaSubtitlesShowing?.length||e.hasAttribute(j.MEDIA_SUBTITLES_SHOWING),bu=e=>{let{media:t,fullscreenElement:n}=e;try{let e=n&&`requestFullscreen`in n?`requestFullscreen`:n&&`webkitRequestFullScreen`in n?`webkitRequestFullScreen`:void 0;if(e){let t=n[e]?.call(n);if(t instanceof Promise)return t.catch(()=>{})}else t?.webkitEnterFullscreen?t.webkitEnterFullscreen():t?.requestFullscreen&&t.requestFullscreen()}catch(e){console.error(e)}},xu=`exitFullscreen`in sc?`exitFullscreen`:`webkitExitFullscreen`in sc?`webkitExitFullscreen`:`webkitCancelFullScreen`in sc?`webkitCancelFullScreen`:void 0,Su=e=>{let{documentElement:t}=e;if(xu){let e=(t?.[xu])?.call(t);if(e instanceof Promise)return e.catch(()=>{})}},Cu=`fullscreenElement`in sc?`fullscreenElement`:`webkitFullscreenElement`in sc?`webkitFullscreenElement`:void 0,wu=e=>{let{documentElement:t,media:n}=e,r=t?.[Cu];return!r&&`webkitDisplayingFullscreen`in n&&`webkitPresentationMode`in n&&n.webkitDisplayingFullscreen&&n.webkitPresentationMode===ks.FULLSCREEN?n:r},Tu=e=>{let{media:t,documentElement:n,fullscreenElement:r=t}=e;if(!t||!n)return!1;let i=wu(e);if(!i)return!1;if(i===r||i===t)return!0;if(i.localName.includes(`-`)){let e=i.shadowRoot;if(!(Cu in e))return yc(i,r);for(;e?.[Cu];){if(e[Cu]===r)return!0;e=e[Cu]?.shadowRoot}}return!1},Eu=`fullscreenEnabled`in sc?`fullscreenEnabled`:`webkitFullscreenEnabled`in sc?`webkitFullscreenEnabled`:void 0,Du=e=>{let{documentElement:t,media:n}=e;return!!t?.[Eu]||n&&`webkitSupportsFullscreen`in n},Ou,ku=()=>{var e;return Ou||(Ou=((e=sc)?.createElement)?.call(e,`video`),Ou)},Au=async(e=ku())=>{if(!e)return!1;let t=e.volume;e.volume=t/2+.1;let n=new AbortController,r=await Promise.race([ju(e,n.signal),Mu(e,t)]);return n.abort(),r},ju=(e,t)=>new Promise(n=>{e.addEventListener(`volumechange`,()=>n(!0),{signal:t})}),Mu=async(e,t)=>{for(let n=0;n<10;n++){if(e.volume===t)return!1;await Vs(10)}return e.volume!==t},Nu=/.*Version\/.*Safari\/.*/.test(N.navigator.userAgent),Pu=(e=ku())=>N.matchMedia(`(display-mode: standalone)`).matches&&Nu?!1:typeof e?.requestPictureInPicture==`function`,Fu=(e=ku())=>Du({documentElement:sc,media:e}),Iu=Fu(),Lu=Pu(),Ru=!!N.WebKitPlaybackTargetAvailabilityEvent,zu=!!N.chrome,Bu=e=>vu(e.media,e=>[ws.SUBTITLES,ws.CAPTIONS].includes(e.kind)).sort((e,t)=>e.kind>=t.kind?1:-1),Vu=e=>vu(e.media,e=>e.mode===Ts.SHOWING&&[ws.SUBTITLES,ws.CAPTIONS].includes(e.kind)),Hu=(e,t)=>{let n=Bu(e),r=Vu(e),i=!!r.length;if(n.length){if(t===!1||i&&t!==!0)_u(Ts.DISABLED,n,r);else if(t===!0||!i&&t!==!1){let t=n[0],{options:i}=e;if(!i?.noSubtitlesLangPref){let e=N.localStorage.getItem(`media-chrome-pref-subtitles-lang`),r=e?[e,...N.navigator.languages]:N.navigator.languages,i=n.filter(e=>r.some(t=>e.language.toLowerCase().startsWith(t.split(`-`)[0]))).sort((e,t)=>r.findIndex(t=>e.language.toLowerCase().startsWith(t.split(`-`)[0]))-r.findIndex(e=>t.language.toLowerCase().startsWith(e.split(`-`)[0])));i[0]&&(t=i[0])}let{language:a,label:o,kind:s}=t;_u(Ts.DISABLED,n,r),_u(Ts.SHOWING,n,[{language:a,label:o,kind:s}])}}},Uu=(e,t)=>e===t?!0:e==null||t==null||typeof e!=typeof t?!1:typeof e==`number`&&Number.isNaN(e)&&Number.isNaN(t)?!0:typeof e==`object`?Array.isArray(e)?Wu(e,t):Object.entries(e).every(([e,n])=>e in t&&Uu(n,t[e])):!1,Wu=(e,t)=>{let n=Array.isArray(e),r=Array.isArray(t);return n===r?n||r?e.length===t.length&&e.every((e,n)=>Uu(e,t[n])):!0:!1},Gu=Object.values(Os),Ku,qu=Au().then(e=>(Ku=e,Ku)),Ju=async(...e)=>{await Promise.all(e.filter(e=>e).map(async e=>{if(!(`localName`in e&&e instanceof N.HTMLElement))return;let t=e.localName;if(!t.includes(`-`))return;let n=N.customElements.get(t);n&&e instanceof n||(await N.customElements.whenDefined(t),N.customElements.upgrade(e))}))},Yu=new N.DOMParser,Xu=e=>e&&(Yu.parseFromString(e,`text/html`).body.textContent||e),Zu={mediaError:{get(e,t){let{media:n}=e;if(t?.type!==`playing`)return n?.error},mediaEvents:[`emptied`,`error`,`playing`]},mediaErrorCode:{get(e,t){let{media:n}=e;if(t?.type!==`playing`)return n?.error?.code},mediaEvents:[`emptied`,`error`,`playing`]},mediaErrorMessage:{get(e,t){let{media:n}=e;if(t?.type!==`playing`)return n?.error?.message??``},mediaEvents:[`emptied`,`error`,`playing`]},mediaWidth:{get(e){let{media:t}=e;return t?.videoWidth??0},mediaEvents:[`resize`]},mediaHeight:{get(e){let{media:t}=e;return t?.videoHeight??0},mediaEvents:[`resize`]},mediaPaused:{get(e){let{media:t}=e;return t?.paused??!0},set(e,t){var n;let{media:r}=t;r&&(e?r.pause():(n=r.play())==null||n.catch(()=>{}))},mediaEvents:[`play`,`playing`,`pause`,`emptied`]},mediaHasPlayed:{get(e,t){let{media:n}=e;return n?t?t.type===`playing`:!n.paused:!1},mediaEvents:[`playing`,`emptied`]},mediaEnded:{get(e){let{media:t}=e;return t?.ended??!1},mediaEvents:[`seeked`,`ended`,`emptied`]},mediaPlaybackRate:{get(e){let{media:t}=e;return t?.playbackRate??1},set(e,t){let{media:n}=t;n&&Number.isFinite(+e)&&(n.playbackRate=+e)},mediaEvents:[`ratechange`,`loadstart`]},mediaMuted:{get(e){let{media:t}=e;return t?.muted??!1},set(e,t){let{media:n,options:{noMutedPref:r}={}}=t;if(n){n.muted=e;try{let t=N.localStorage.getItem(`media-chrome-pref-muted`)!==null,i=n.hasAttribute(`muted`);if(r){t&&N.localStorage.removeItem(`media-chrome-pref-muted`);return}if(i&&!t)return;N.localStorage.setItem(`media-chrome-pref-muted`,e?`true`:`false`)}catch(e){console.debug(`Error setting muted pref`,e)}}},mediaEvents:[`volumechange`],stateOwnersUpdateHandlers:[(e,t)=>{let{options:{noMutedPref:n}}=t,{media:r}=t;if(!(!r||r.muted||n))try{let n=N.localStorage.getItem(`media-chrome-pref-muted`)===`true`;Zu.mediaMuted.set(n,t),e(n)}catch(e){console.debug(`Error getting muted pref`,e)}}]},mediaLoop:{get(e){let{media:t}=e;return t?.loop},set(e,t){let{media:n}=t;n&&(n.loop=e)},mediaEvents:[`medialooprequest`]},mediaVolume:{get(e){let{media:t}=e;return t?.volume??1},set(e,t){let{media:n,options:{noVolumePref:r}={}}=t;if(n){try{e==null?N.localStorage.removeItem(`media-chrome-pref-volume`):!n.hasAttribute(`muted`)&&!r&&N.localStorage.setItem(`media-chrome-pref-volume`,e.toString())}catch(e){console.debug(`Error setting volume pref`,e)}Number.isFinite(+e)&&(n.volume=+e)}},mediaEvents:[`volumechange`],stateOwnersUpdateHandlers:[(e,t)=>{let{options:{noVolumePref:n}}=t;if(!n)try{let{media:n}=t;if(!n)return;let r=N.localStorage.getItem(`media-chrome-pref-volume`);if(r==null)return;Zu.mediaVolume.set(+r,t),e(+r)}catch(e){console.debug(`Error getting volume pref`,e)}}]},mediaVolumeLevel:{get(e){let{media:t}=e;return t?.volume===void 0?`high`:t.muted||t.volume===0?`off`:t.volume<.5?`low`:t.volume<.75?`medium`:`high`},mediaEvents:[`volumechange`]},mediaCurrentTime:{get(e){let{media:t}=e;return t?.currentTime??0},set(e,t){let{media:n}=t;n&&zs(e)&&(n.currentTime=e)},mediaEvents:[`timeupdate`,`loadedmetadata`,`seeking`]},mediaDuration:{get(e){let{media:t,options:{defaultDuration:n}={}}=e;return n&&(!t||!t.duration||Number.isNaN(t.duration)||!Number.isFinite(t.duration))?n:Number.isFinite(t?.duration)?t.duration:NaN},mediaEvents:[`durationchange`,`loadedmetadata`,`emptied`]},mediaLoading:{get(e){let{media:t}=e;return t?.readyState<3},mediaEvents:[`waiting`,`playing`,`emptied`]},mediaSeekable:{get(e){let{media:t}=e;if(!t?.seekable?.length)return;let n=t.seekable.start(0),r=t.seekable.end(t.seekable.length-1);if(n||r)return[Number(n.toFixed(3)),Number(r.toFixed(3))]},mediaEvents:[`loadedmetadata`,`emptied`,`progress`,`seekablechange`]},mediaBuffered:{get(e){let{media:t}=e,n=t?.buffered??[];return Array.from(n).map((e,t)=>[Number(n.start(t).toFixed(3)),Number(n.end(t).toFixed(3))])},mediaEvents:[`progress`,`emptied`]},mediaStreamType:{get(e){let{media:t,options:{defaultStreamType:n}={}}=e,r=[Os.LIVE,Os.ON_DEMAND].includes(n)?n:void 0;if(!t)return r;let{streamType:i}=t;if(Gu.includes(i))return i===Os.UNKNOWN?r:i;let a=t.duration;return a===1/0?Os.LIVE:Number.isFinite(a)?Os.ON_DEMAND:r},mediaEvents:[`emptied`,`durationchange`,`loadedmetadata`,`streamtypechange`]},mediaTargetLiveWindow:{get(e){let{media:t}=e;if(!t)return NaN;let{targetLiveWindow:n}=t,r=Zu.mediaStreamType.get(e);return(n==null||Number.isNaN(n))&&r===Os.LIVE?0:n},mediaEvents:[`emptied`,`durationchange`,`loadedmetadata`,`streamtypechange`,`targetlivewindowchange`]},mediaTimeIsLive:{get(e){let{media:t,options:{liveEdgeOffset:n=10}={}}=e;if(!t)return!1;if(typeof t.liveEdgeStart==`number`)return!Number.isNaN(t.liveEdgeStart)&&t.currentTime>=t.liveEdgeStart;if(Zu.mediaStreamType.get(e)!==Os.LIVE)return!1;let r=t.seekable;if(!r)return!0;if(!r.length)return!1;let i=r.end(r.length-1)-n;return t.currentTime>=i},mediaEvents:[`playing`,`timeupdate`,`progress`,`waiting`,`emptied`]},mediaSubtitlesList:{get(e){return Bu(e).map(({kind:e,label:t,language:n})=>({kind:e,label:t,language:n}))},mediaEvents:[`loadstart`],textTracksEvents:[`addtrack`,`removetrack`]},mediaSubtitlesShowing:{get(e){return Vu(e).map(({kind:e,label:t,language:n})=>({kind:e,label:t,language:n}))},mediaEvents:[`loadstart`],textTracksEvents:[`addtrack`,`removetrack`,`change`],stateOwnersUpdateHandlers:[(e,t)=>{var n,r;let{media:i,options:a}=t;if(!i)return;let o=e=>{a.defaultSubtitles&&(!e||[ws.CAPTIONS,ws.SUBTITLES].includes(e?.track?.kind))&&Hu(t,!0)};return i.addEventListener(`loadstart`,o),(n=i.textTracks)==null||n.addEventListener(`addtrack`,o),(r=i.textTracks)==null||r.addEventListener(`removetrack`,o),()=>{var e,t;i.removeEventListener(`loadstart`,o),(e=i.textTracks)==null||e.removeEventListener(`addtrack`,o),(t=i.textTracks)==null||t.removeEventListener(`removetrack`,o)}}]},mediaChaptersCues:{get(e){let{media:t}=e;if(!t)return[];let[n]=vu(t,{kind:ws.CHAPTERS});return Array.from(n?.cues??[]).map(({text:e,startTime:t,endTime:n})=>({text:Xu(e),startTime:t,endTime:n}))},mediaEvents:[`loadstart`,`loadedmetadata`],textTracksEvents:[`addtrack`,`removetrack`,`change`],stateOwnersUpdateHandlers:[(e,t)=>{let{media:n}=t;if(!n)return;let r=n.querySelector(`track[kind="chapters"][default][src]`),i=n.shadowRoot?.querySelector(`:is(video,audio) > track[kind="chapters"][default][src]`);return r?.addEventListener(`load`,e),i?.addEventListener(`load`,e),()=>{r?.removeEventListener(`load`,e),i?.removeEventListener(`load`,e)}}]},mediaIsPip:{get(e){let{media:t,documentElement:n}=e;if(!t||!n||!n.pictureInPictureElement)return!1;if(n.pictureInPictureElement===t)return!0;if(n.pictureInPictureElement instanceof HTMLMediaElement)return t.localName?.includes(`-`)?yc(t,n.pictureInPictureElement):!1;if(n.pictureInPictureElement.localName.includes(`-`)){let e=n.pictureInPictureElement.shadowRoot;for(;e?.pictureInPictureElement;){if(e.pictureInPictureElement===t)return!0;e=e.pictureInPictureElement?.shadowRoot}}return!1},set(e,t){let{media:n}=t;if(n){if(e){if(!sc.pictureInPictureEnabled){console.warn(`MediaChrome: Picture-in-picture is not enabled`);return}if(!n.requestPictureInPicture){console.warn(`MediaChrome: The current media does not support picture-in-picture`);return}let e=()=>{console.warn(`MediaChrome: The media is not ready for picture-in-picture. It must have a readyState > 0.`)};n.requestPictureInPicture().catch(t=>{if(t.code===11){if(!n.src){console.warn(`MediaChrome: The media is not ready for picture-in-picture. It must have a src set.`);return}if(n.readyState===0&&n.preload===`none`){let t=()=>{n.removeEventListener(`loadedmetadata`,r),n.preload=`none`},r=()=>{n.requestPictureInPicture().catch(e),t()};n.addEventListener(`loadedmetadata`,r),n.preload=`metadata`,setTimeout(()=>{n.readyState===0&&e(),t()},1e3)}else throw t}else throw t})}else sc.pictureInPictureElement&&sc.exitPictureInPicture()}},mediaEvents:[`enterpictureinpicture`,`leavepictureinpicture`]},mediaRenditionList:{get(e){let{media:t}=e;return[...t?.videoRenditions??[]].map(e=>({...e}))},mediaEvents:[`emptied`,`loadstart`],videoRenditionsEvents:[`addrendition`,`removerendition`]},mediaRenditionSelected:{get(e){let{media:t}=e;return t?.videoRenditions?.[t.videoRenditions?.selectedIndex]?.id},set(e,t){let{media:n}=t;if(!n?.videoRenditions){console.warn(`MediaController: Rendition selection not supported by this media.`);return}let r=e,i=Array.prototype.findIndex.call(n.videoRenditions,e=>e.id==r);n.videoRenditions.selectedIndex!=i&&(n.videoRenditions.selectedIndex=i)},mediaEvents:[`emptied`],videoRenditionsEvents:[`addrendition`,`removerendition`,`change`]},mediaAudioTrackList:{get(e){let{media:t}=e;return[...t?.audioTracks??[]]},mediaEvents:[`emptied`,`loadstart`],audioTracksEvents:[`addtrack`,`removetrack`]},mediaAudioTrackEnabled:{get(e){let{media:t}=e;return[...t?.audioTracks??[]].find(e=>e.enabled)?.id},set(e,t){let{media:n}=t;if(!n?.audioTracks){console.warn(`MediaChrome: Audio track selection not supported by this media.`);return}let r=e;for(let e of n.audioTracks)e.enabled=r==e.id},mediaEvents:[`emptied`],audioTracksEvents:[`addtrack`,`removetrack`,`change`]},mediaIsFullscreen:{get(e){return Tu(e)},set(e,t,n){var r;e?(bu(t),n.detail&&!t.media?.inert&&((r=t.media)==null||r.focus())):Su(t)},rootEvents:[`fullscreenchange`,`webkitfullscreenchange`],mediaEvents:[`webkitbeginfullscreen`,`webkitendfullscreen`,`webkitpresentationmodechanged`]},mediaIsCasting:{get(e){let{media:t}=e;return!t?.remote||t.remote?.state===`disconnected`?!1:t.remote.state===`connected`},set(e,t){let{media:n}=t;n&&(e&&n.remote?.state!==`disconnected`||(e||n.remote?.state===`connected`)&&(typeof n.remote.prompt==`function`?n.remote.prompt().catch(()=>{}):console.warn(`MediaChrome: Casting is not supported in this environment`)))},remoteEvents:[`connect`,`connecting`,`disconnect`]},mediaIsAirplaying:{get(){return!1},set(e,t){let{media:n}=t;n&&(n.webkitShowPlaybackTargetPicker&&N.WebKitPlaybackTargetAvailabilityEvent?n.webkitShowPlaybackTargetPicker():console.error(`MediaChrome: received a request to select AirPlay but AirPlay is not supported in this environment`))},mediaEvents:[`webkitcurrentplaybacktargetiswirelesschanged`]},mediaFullscreenUnavailable:{get(e){let{media:t}=e;if(!Iu||!Fu(t))return Ds.UNSUPPORTED}},mediaPipUnavailable:{get(e){let{media:t}=e;if(!Lu||!Pu(t))return Ds.UNSUPPORTED;if(t?.disablePictureInPicture)return Ds.UNAVAILABLE}},mediaVolumeUnavailable:{get(e){let{media:t}=e;if(Ku===!1||t?.volume==null)return Ds.UNSUPPORTED},stateOwnersUpdateHandlers:[e=>{Ku??qu.then(t=>e(t?void 0:Ds.UNSUPPORTED))}]},mediaCastUnavailable:{get(e,{availability:t=`not-available`}={}){let{media:n}=e;if(!zu||!n?.remote?.state)return Ds.UNSUPPORTED;if(t!=null&&t!==`available`)return Ds.UNAVAILABLE},stateOwnersUpdateHandlers:[(e,t)=>{var n;let{media:r}=t;if(r)return r.disableRemotePlayback||r.hasAttribute(`disableremoteplayback`)||(n=r?.remote)==null||n.watchAvailability(t=>{e({availability:t?`available`:`not-available`})}).catch(t=>{t.name===`NotSupportedError`?e({availability:null}):e({availability:`not-available`})}),()=>{var e;(e=r?.remote)==null||e.cancelWatchAvailability().catch(()=>{})}}]},mediaAirplayUnavailable:{get(e,t){if(!Ru)return Ds.UNSUPPORTED;if(t?.availability===`not-available`)return Ds.UNAVAILABLE},mediaEvents:[`webkitplaybacktargetavailabilitychanged`],stateOwnersUpdateHandlers:[(e,t)=>{var n;let{media:r}=t;if(r)return r.disableRemotePlayback||r.hasAttribute(`disableremoteplayback`)||(n=r?.remote)==null||n.watchAvailability(t=>{e({availability:t?`available`:`not-available`})}).catch(t=>{t.name===`NotSupportedError`?e({availability:null}):e({availability:`not-available`})}),()=>{var e;(e=r?.remote)==null||e.cancelWatchAvailability().catch(()=>{})}}]},mediaRenditionUnavailable:{get(e){let{media:t}=e;if(!t?.videoRenditions)return Ds.UNSUPPORTED;if(!t.videoRenditions?.length)return Ds.UNAVAILABLE},mediaEvents:[`emptied`,`loadstart`],videoRenditionsEvents:[`addrendition`,`removerendition`]},mediaAudioTrackUnavailable:{get(e){let{media:t}=e;if(!t?.audioTracks)return Ds.UNSUPPORTED;if((t.audioTracks?.length??0)<=1)return Ds.UNAVAILABLE},mediaEvents:[`emptied`,`loadstart`],audioTracksEvents:[`addtrack`,`removetrack`]},mediaLang:{get(e){let{options:{mediaLang:t}={}}=e;return t??`en`}}},Qu={[k.MEDIA_PREVIEW_REQUEST](e,t,{detail:n}){let{media:r}=t,i=n??void 0,a,o;if(r&&i!=null){let[e]=vu(r,{kind:ws.METADATA,label:`thumbnails`}),t=Array.prototype.find.call(e?.cues??[],(e,t,n)=>t===0?e.endTime>i:t===n.length-1?e.startTime<=i:e.startTime<=i&&e.endTime>i);if(t){let e=/'^(?:[a-z]+:)?\/\//i.test(t.text)?void 0:r?.querySelector(`track[label="thumbnails"]`)?.src,n=new URL(t.text,e);o=new URLSearchParams(n.hash).get(`#xywh`).split(`,`).map(e=>+e),a=n.href}}let s=e.mediaDuration.get(t),c=e.mediaChaptersCues.get(t).find((e,t,n)=>t===n.length-1&&s===e.endTime?e.startTime<=i&&e.endTime>=i:e.startTime<=i&&e.endTime>i)?.text;return n!=null&&c==null&&(c=``),{mediaPreviewTime:i,mediaPreviewImage:a,mediaPreviewCoords:o,mediaPreviewChapter:c}},[k.MEDIA_PAUSE_REQUEST](e,t){e.mediaPaused.set(!0,t)},[k.MEDIA_PLAY_REQUEST](e,t){let n=e.mediaStreamType.get(t)===Os.LIVE,r=!t.options?.noAutoSeekToLive,i=e.mediaTargetLiveWindow.get(t)>0;if(n&&r&&!i){let n=e.mediaSeekable.get(t)?.[1];if(n){let r=n-(t.options?.seekToLiveOffset??0);e.mediaCurrentTime.set(r,t)}}e.mediaPaused.set(!1,t)},[k.MEDIA_PLAYBACK_RATE_REQUEST](e,t,{detail:n}){let r=n;e.mediaPlaybackRate.set(r,t)},[k.MEDIA_MUTE_REQUEST](e,t){e.mediaMuted.set(!0,t)},[k.MEDIA_UNMUTE_REQUEST](e,t){e.mediaVolume.get(t)||e.mediaVolume.set(.25,t),e.mediaMuted.set(!1,t)},[k.MEDIA_LOOP_REQUEST](e,t,{detail:n}){let r=!!n;return e.mediaLoop.set(r,t),{mediaLoop:r}},[k.MEDIA_VOLUME_REQUEST](e,t,{detail:n}){let r=n;r&&e.mediaMuted.get(t)&&e.mediaMuted.set(!1,t),e.mediaVolume.set(r,t)},[k.MEDIA_SEEK_REQUEST](e,t,{detail:n}){let r=n;e.mediaCurrentTime.set(r,t)},[k.MEDIA_SEEK_TO_LIVE_REQUEST](e,t){let n=e.mediaSeekable.get(t)?.[1];if(Number.isNaN(Number(n)))return;let r=n-(t.options?.seekToLiveOffset??0);e.mediaCurrentTime.set(r,t)},[k.MEDIA_SHOW_SUBTITLES_REQUEST](e,t,{detail:n}){let{options:r}=t,i=Bu(t),a=fu(n),o=a[0]?.language;o&&!r.noSubtitlesLangPref&&N.localStorage.setItem(`media-chrome-pref-subtitles-lang`,o),_u(Ts.SHOWING,i,a)},[k.MEDIA_DISABLE_SUBTITLES_REQUEST](e,t,{detail:n}){let r=Bu(t),i=n??[];_u(Ts.DISABLED,r,i)},[k.MEDIA_TOGGLE_SUBTITLES_REQUEST](e,t,{detail:n}){Hu(t,n)},[k.MEDIA_RENDITION_REQUEST](e,t,{detail:n}){let r=n;e.mediaRenditionSelected.set(r,t)},[k.MEDIA_AUDIO_TRACK_REQUEST](e,t,{detail:n}){let r=n;e.mediaAudioTrackEnabled.set(r,t)},[k.MEDIA_ENTER_PIP_REQUEST](e,t){e.mediaIsFullscreen.get(t)&&e.mediaIsFullscreen.set(!1,t),e.mediaIsPip.set(!0,t)},[k.MEDIA_EXIT_PIP_REQUEST](e,t){e.mediaIsPip.set(!1,t)},[k.MEDIA_ENTER_FULLSCREEN_REQUEST](e,t,n){e.mediaIsPip.get(t)&&e.mediaIsPip.set(!1,t),e.mediaIsFullscreen.set(!0,t,n)},[k.MEDIA_EXIT_FULLSCREEN_REQUEST](e,t){e.mediaIsFullscreen.set(!1,t)},[k.MEDIA_ENTER_CAST_REQUEST](e,t){e.mediaIsFullscreen.get(t)&&e.mediaIsFullscreen.set(!1,t),e.mediaIsCasting.set(!0,t)},[k.MEDIA_EXIT_CAST_REQUEST](e,t){e.mediaIsCasting.set(!1,t)},[k.MEDIA_AIRPLAY_REQUEST](e,t){e.mediaIsAirplaying.set(!0,t)}},$u=({media:e,fullscreenElement:t,documentElement:n,stateMediator:r=Zu,requestMap:i=Qu,options:a={},monitorStateOwnersOnlyWithSubscriptions:o=!0})=>{let s=[],c={options:{...a}},l=Object.freeze({mediaPreviewTime:void 0,mediaPreviewImage:void 0,mediaPreviewCoords:void 0,mediaPreviewChapter:void 0}),u=e=>{e!=null&&(Uu(e,l)||(l=Object.freeze({...l,...e}),s.forEach(e=>e(l))))},d=()=>{let e=Object.entries(r).reduce((e,[t,{get:n}])=>(e[t]=n(c),e),{});u(e)},f={},p,m=async(e,t)=>{let n=!!p;if(p={...c,...p??{},...e},n)return;await Ju(...Object.values(e));let i=s.length>0&&t===0&&o,a=c.media!==p.media,l=c.media?.textTracks!==p.media?.textTracks,m=c.media?.videoRenditions!==p.media?.videoRenditions,h=c.media?.audioTracks!==p.media?.audioTracks,ee=c.media?.remote!==p.media?.remote,te=c.documentElement!==p.documentElement,ne=!!c.media&&(a||i),re=!!c.media?.textTracks&&(l||i),ie=!!c.media?.videoRenditions&&(m||i),ae=!!c.media?.audioTracks&&(h||i),oe=!!c.media?.remote&&(ee||i),se=!!c.documentElement&&(te||i),ce=ne||re||ie||ae||oe||se,le=s.length===0&&t===1&&o,ue=!!p.media&&(a||le),de=!!p.media?.textTracks&&(l||le),fe=!!p.media?.videoRenditions&&(m||le),pe=!!p.media?.audioTracks&&(h||le),me=!!p.media?.remote&&(ee||le),he=!!p.documentElement&&(te||le),ge=ue||de||fe||pe||me||he;ce||ge?(Object.entries(r).forEach(([e,{get:t,mediaEvents:n=[],textTracksEvents:r=[],videoRenditionsEvents:i=[],audioTracksEvents:a=[],remoteEvents:o=[],rootEvents:s=[],stateOwnersUpdateHandlers:l=[]}])=>{f[e]||(f[e]={});let d=n=>{let r=t(c,n);u({[e]:r})},m;m=f[e].mediaEvents,n.forEach(t=>{m&&ne&&(c.media.removeEventListener(t,m),f[e].mediaEvents=void 0),ue&&(p.media.addEventListener(t,d),f[e].mediaEvents=d)}),m=f[e].textTracksEvents,r.forEach(t=>{var n,r;m&&re&&((n=c.media.textTracks)==null||n.removeEventListener(t,m),f[e].textTracksEvents=void 0),de&&((r=p.media.textTracks)==null||r.addEventListener(t,d),f[e].textTracksEvents=d)}),m=f[e].videoRenditionsEvents,i.forEach(t=>{var n,r;m&&ie&&((n=c.media.videoRenditions)==null||n.removeEventListener(t,m),f[e].videoRenditionsEvents=void 0),fe&&((r=p.media.videoRenditions)==null||r.addEventListener(t,d),f[e].videoRenditionsEvents=d)}),m=f[e].audioTracksEvents,a.forEach(t=>{var n,r;m&&ae&&((n=c.media.audioTracks)==null||n.removeEventListener(t,m),f[e].audioTracksEvents=void 0),pe&&((r=p.media.audioTracks)==null||r.addEventListener(t,d),f[e].audioTracksEvents=d)}),m=f[e].remoteEvents,o.forEach(t=>{var n,r;m&&oe&&((n=c.media.remote)==null||n.removeEventListener(t,m),f[e].remoteEvents=void 0),me&&((r=p.media.remote)==null||r.addEventListener(t,d),f[e].remoteEvents=d)}),m=f[e].rootEvents,s.forEach(t=>{m&&se&&(c.documentElement.removeEventListener(t,m),f[e].rootEvents=void 0),he&&(p.documentElement.addEventListener(t,d),f[e].rootEvents=d)});let h=f[e].stateOwnersUpdateHandlers;if(h&&ce&&(Array.isArray(h)?h:[h]).forEach(e=>{typeof e==`function`&&e()}),ge){let t=l.map(e=>e(d,p)).filter(e=>typeof e==`function`);f[e].stateOwnersUpdateHandlers=t.length===1?t[0]:t}else ce&&(f[e].stateOwnersUpdateHandlers=void 0)}),Object.entries(p).forEach(([e,t])=>{c[e]=t}),d(),p=void 0):(Object.entries(p).forEach(([e,t])=>{c[e]=t}),d(),p=void 0)};return m({media:e,fullscreenElement:t,documentElement:n,options:a}),{dispatch(e){let{type:t,detail:n}=e;i[t]&&l.mediaErrorCode==null?u(i[t](r,c,e)):t===`mediaelementchangerequest`?m({media:n}):t===`fullscreenelementchangerequest`?m({fullscreenElement:n}):t===`documentelementchangerequest`?m({documentElement:n}):t===`optionschangerequest`&&(Object.entries(n??{}).forEach(([e,t])=>{c.options[e]=t}),d())},getState(){return l},subscribe(e){return m({},s.length+1),s.push(e),e(l),()=>{let t=s.indexOf(e);t>=0&&(m({},s.length-1),s.splice(t,1))}}}},ed=(e,t,n)=>{if(!t.has(e))throw TypeError(`Cannot `+n)},V=(e,t,n)=>(ed(e,t,`read from private field`),n?n.call(e):t.get(e)),td=(e,t,n)=>{if(t.has(e))throw TypeError(`Cannot add the same private member more than once`);t instanceof WeakSet?t.add(e):t.set(e,n)},nd=(e,t,n,r)=>(ed(e,t,`write to private field`),r?r.call(e,n):t.set(e,n),n),rd=(e,t,n)=>(ed(e,t,`access private method`),n),id,ad,H,od,sd,cd,ld,ud,dd,fd,pd,md,hd,gd,_d,vd,yd,bd=[`ArrowLeft`,`ArrowRight`,`ArrowUp`,`ArrowDown`,`Enter`,` `,`f`,`m`,`k`,`c`,`l`,`j`,`>`,`<`,`p`],xd=10,Sd=.025,Cd=.25,wd=.25,Td=2,U={DEFAULT_SUBTITLES:`defaultsubtitles`,DEFAULT_STREAM_TYPE:`defaultstreamtype`,DEFAULT_DURATION:`defaultduration`,FULLSCREEN_ELEMENT:`fullscreenelement`,HOTKEYS:`hotkeys`,KEYBOARD_BACKWARD_SEEK_OFFSET:`keyboardbackwardseekoffset`,KEYBOARD_FORWARD_SEEK_OFFSET:`keyboardforwardseekoffset`,KEYBOARD_DOWN_VOLUME_STEP:`keyboarddownvolumestep`,KEYBOARD_UP_VOLUME_STEP:`keyboardupvolumestep`,KEYS_USED:`keysused`,LANG:`lang`,LOOP:`loop`,LIVE_EDGE_OFFSET:`liveedgeoffset`,NO_AUTO_SEEK_TO_LIVE:`noautoseektolive`,NO_DEFAULT_STORE:`nodefaultstore`,NO_HOTKEYS:`nohotkeys`,NO_MUTED_PREF:`nomutedpref`,NO_SUBTITLES_LANG_PREF:`nosubtitleslangpref`,NO_VOLUME_PREF:`novolumepref`,SEEK_TO_LIVE_OFFSET:`seektoliveoffset`},Ed=class extends hl{constructor(){super(),td(this,dd),td(this,md),td(this,gd),td(this,vd),this.mediaStateReceivers=[],this.associatedElementSubscriptions=new Map,td(this,id,new cu(this,U.HOTKEYS)),td(this,ad,void 0),td(this,H,void 0),td(this,od,null),td(this,sd,void 0),td(this,cd,void 0),td(this,ld,e=>{var t;(t=V(this,H))==null||t.dispatch(e)}),td(this,ud,void 0),td(this,pd,e=>{let{key:t,shiftKey:n}=e;n&&(t===`/`||t===`?`)||bd.includes(t)?this.keyboardShortcutHandler(e):this.removeEventListener(`keyup`,V(this,pd))}),this.associateElement(this);let e={};nd(this,sd,t=>{Object.entries(t).forEach(([t,n])=>{if(t in e&&e[t]===n)return;this.propagateMediaState(t,n);let r=t.toLowerCase(),i=new N.CustomEvent(Cs[r],{composed:!0,detail:n});this.dispatchEvent(i)}),e=t})}static get observedAttributes(){return super.observedAttributes.concat(U.NO_HOTKEYS,U.HOTKEYS,U.DEFAULT_STREAM_TYPE,U.DEFAULT_SUBTITLES,U.DEFAULT_DURATION,U.NO_MUTED_PREF,U.NO_VOLUME_PREF,U.LANG,U.LOOP,U.LIVE_EDGE_OFFSET,U.SEEK_TO_LIVE_OFFSET,U.NO_AUTO_SEEK_TO_LIVE)}get mediaStore(){return V(this,H)}set mediaStore(e){var t;V(this,H)&&((t=V(this,cd))==null||t.call(this),nd(this,cd,void 0)),nd(this,H,e),!V(this,H)&&!this.hasAttribute(U.NO_DEFAULT_STORE)?rd(this,dd,fd).call(this):nd(this,cd,V(this,H)?.subscribe(V(this,sd)))}get fullscreenElement(){return V(this,ad)??this}set fullscreenElement(e){var t;this.hasAttribute(U.FULLSCREEN_ELEMENT)&&this.removeAttribute(U.FULLSCREEN_ELEMENT),nd(this,ad,e),(t=V(this,H))==null||t.dispatch({type:`fullscreenelementchangerequest`,detail:this.fullscreenElement})}get defaultSubtitles(){return I(this,U.DEFAULT_SUBTITLES)}set defaultSubtitles(e){L(this,U.DEFAULT_SUBTITLES,e)}get defaultStreamType(){return R(this,U.DEFAULT_STREAM_TYPE)}set defaultStreamType(e){z(this,U.DEFAULT_STREAM_TYPE,e)}get defaultDuration(){return P(this,U.DEFAULT_DURATION)}set defaultDuration(e){F(this,U.DEFAULT_DURATION,e)}get noHotkeys(){return I(this,U.NO_HOTKEYS)}set noHotkeys(e){L(this,U.NO_HOTKEYS,e)}get keysUsed(){return R(this,U.KEYS_USED)}set keysUsed(e){z(this,U.KEYS_USED,e)}get liveEdgeOffset(){return P(this,U.LIVE_EDGE_OFFSET)}set liveEdgeOffset(e){F(this,U.LIVE_EDGE_OFFSET,e)}get noAutoSeekToLive(){return I(this,U.NO_AUTO_SEEK_TO_LIVE)}set noAutoSeekToLive(e){L(this,U.NO_AUTO_SEEK_TO_LIVE,e)}get noVolumePref(){return I(this,U.NO_VOLUME_PREF)}set noVolumePref(e){L(this,U.NO_VOLUME_PREF,e)}get noMutedPref(){return I(this,U.NO_MUTED_PREF)}set noMutedPref(e){L(this,U.NO_MUTED_PREF,e)}get noSubtitlesLangPref(){return I(this,U.NO_SUBTITLES_LANG_PREF)}set noSubtitlesLangPref(e){L(this,U.NO_SUBTITLES_LANG_PREF,e)}get noDefaultStore(){return I(this,U.NO_DEFAULT_STORE)}set noDefaultStore(e){L(this,U.NO_DEFAULT_STORE,e)}get resolvedLang(){return Js()}attributeChangedCallback(e,t,n){var r,i,a,o,s,c,l,u,d,f;if(super.attributeChangedCallback(e,t,n),e===U.NO_HOTKEYS)n!==t&&n===``?(this.hasAttribute(U.HOTKEYS)&&console.warn("Media Chrome: Both `hotkeys` and `nohotkeys` have been set. All hotkeys will be disabled."),this.disableHotkeys()):n!==t&&n===null&&this.enableHotkeys(),rd(this,gd,_d).call(this);else if(e===U.HOTKEYS)V(this,id).value=n,rd(this,gd,_d).call(this);else if(e===U.DEFAULT_SUBTITLES&&n!==t)(r=V(this,H))==null||r.dispatch({type:`optionschangerequest`,detail:{defaultSubtitles:this.hasAttribute(U.DEFAULT_SUBTITLES)}});else if(e===U.DEFAULT_STREAM_TYPE)(i=V(this,H))==null||i.dispatch({type:`optionschangerequest`,detail:{defaultStreamType:this.getAttribute(U.DEFAULT_STREAM_TYPE)??void 0}});else if(e===U.LIVE_EDGE_OFFSET&&n!==t)(a=V(this,H))==null||a.dispatch({type:`optionschangerequest`,detail:{liveEdgeOffset:this.hasAttribute(U.LIVE_EDGE_OFFSET)?+this.getAttribute(U.LIVE_EDGE_OFFSET):void 0,seekToLiveOffset:this.hasAttribute(U.SEEK_TO_LIVE_OFFSET)?+this.getAttribute(U.SEEK_TO_LIVE_OFFSET):this.hasAttribute(U.LIVE_EDGE_OFFSET)?+this.getAttribute(U.LIVE_EDGE_OFFSET):void 0}});else if(e===U.SEEK_TO_LIVE_OFFSET&&n!==t)(o=V(this,H))==null||o.dispatch({type:`optionschangerequest`,detail:{seekToLiveOffset:this.hasAttribute(U.SEEK_TO_LIVE_OFFSET)?+this.getAttribute(U.SEEK_TO_LIVE_OFFSET):this.hasAttribute(U.LIVE_EDGE_OFFSET)?+this.getAttribute(U.LIVE_EDGE_OFFSET):void 0}});else if(e===U.NO_AUTO_SEEK_TO_LIVE)(s=V(this,H))==null||s.dispatch({type:`optionschangerequest`,detail:{noAutoSeekToLive:this.hasAttribute(U.NO_AUTO_SEEK_TO_LIVE)}});else if(e===U.FULLSCREEN_ELEMENT){let e=n?this.getRootNode()?.getElementById(n):void 0;nd(this,ad,e),(c=V(this,H))==null||c.dispatch({type:`fullscreenelementchangerequest`,detail:this.fullscreenElement})}else e===U.LANG&&n!==t?(Ks(n),(l=V(this,H))==null||l.dispatch({type:`optionschangerequest`,detail:{mediaLang:n}})):e===U.LOOP&&n!==t?(u=V(this,H))==null||u.dispatch({type:k.MEDIA_LOOP_REQUEST,detail:n!=null}):e===U.NO_VOLUME_PREF&&n!==t?(d=V(this,H))==null||d.dispatch({type:`optionschangerequest`,detail:{noVolumePref:this.hasAttribute(U.NO_VOLUME_PREF)}}):e===U.NO_MUTED_PREF&&n!==t&&((f=V(this,H))==null||f.dispatch({type:`optionschangerequest`,detail:{noMutedPref:this.hasAttribute(U.NO_MUTED_PREF)}}))}connectedCallback(){var e,t;this.associateElement(this),!V(this,H)&&!this.hasAttribute(U.NO_DEFAULT_STORE)&&rd(this,dd,fd).call(this),(e=V(this,H))==null||e.dispatch({type:`documentelementchangerequest`,detail:sc}),(t=V(this,H))==null||t.dispatch({type:`fullscreenelementchangerequest`,detail:this.fullscreenElement}),super.connectedCallback(),V(this,H)&&!V(this,cd)&&nd(this,cd,V(this,H)?.subscribe(V(this,sd))),V(this,ud)!==void 0&&V(this,H)&&this.media&&setTimeout(()=>{var e;this.media?.textTracks?.length&&((e=V(this,H))==null||e.dispatch({type:k.MEDIA_TOGGLE_SUBTITLES_REQUEST,detail:V(this,ud)}))},0),this.hasAttribute(U.NO_HOTKEYS)?this.disableHotkeys():this.enableHotkeys()}disconnectedCallback(){var e,t,n,r,i;if((e=super.disconnectedCallback)==null||e.call(this),this.disableHotkeys(),V(this,H)){let e=V(this,H).getState();nd(this,ud,!!e.mediaSubtitlesShowing?.length),(t=V(this,H))==null||t.dispatch({type:`fullscreenelementchangerequest`,detail:void 0}),(n=V(this,H))==null||n.dispatch({type:`documentelementchangerequest`,detail:void 0}),(r=V(this,H))==null||r.dispatch({type:k.MEDIA_TOGGLE_SUBTITLES_REQUEST,detail:!1})}V(this,cd)&&((i=V(this,cd))==null||i.call(this),nd(this,cd,void 0)),this.unassociateElement(this),V(this,od)&&(V(this,od).remove(),nd(this,od,null))}mediaSetCallback(e){var t;super.mediaSetCallback(e),(t=V(this,H))==null||t.dispatch({type:`mediaelementchangerequest`,detail:e}),e.hasAttribute(`tabindex`)||(e.tabIndex=-1)}mediaUnsetCallback(e){var t;super.mediaUnsetCallback(e),(t=V(this,H))==null||t.dispatch({type:`mediaelementchangerequest`,detail:void 0})}propagateMediaState(e,t){Ld(this.mediaStateReceivers,e,t)}associateElement(e){if(!e)return;let{associatedElementSubscriptions:t}=this;if(t.has(e))return;let n=Rd(e,this.registerMediaStateReceiver.bind(this),this.unregisterMediaStateReceiver.bind(this));Object.values(k).forEach(t=>{e.addEventListener(t,V(this,ld))}),t.set(e,n)}unassociateElement(e){if(!e)return;let{associatedElementSubscriptions:t}=this;t.has(e)&&(t.get(e)(),t.delete(e),Object.values(k).forEach(t=>{e.removeEventListener(t,V(this,ld))}))}registerMediaStateReceiver(e){if(!e)return;let t=this.mediaStateReceivers;t.indexOf(e)>-1||(t.push(e),V(this,H)&&Object.entries(V(this,H).getState()).forEach(([t,n])=>{Ld([e],t,n)}))}unregisterMediaStateReceiver(e){let t=this.mediaStateReceivers,n=t.indexOf(e);n<0||t.splice(n,1)}enableHotkeys(){this.addEventListener(`keydown`,rd(this,md,hd))}disableHotkeys(){this.removeEventListener(`keydown`,rd(this,md,hd)),this.removeEventListener(`keyup`,V(this,pd))}get hotkeys(){return V(this,id)}set hotkeys(e){z(this,U.HOTKEYS,e)}keyboardShortcutHandler(e){let t=e.target;if((t.getAttribute(U.KEYS_USED)?.split(` `)??t?.keysUsed??[]).map(e=>e===`Space`?` `:e).filter(Boolean).includes(e.key))return;let n,r,i;if(!V(this,id).contains(ql(e.key))&&(!e.shiftKey||e.key!==`/`&&e.key!==`?`||!V(this,id).contains(`noshift+/`)))switch(e.key){case` `:case`k`:n=V(this,H).getState().mediaPaused?k.MEDIA_PLAY_REQUEST:k.MEDIA_PAUSE_REQUEST,this.dispatchEvent(new N.CustomEvent(n,{composed:!0,bubbles:!0}));break;case`m`:n=this.mediaStore.getState().mediaVolumeLevel===`off`?k.MEDIA_UNMUTE_REQUEST:k.MEDIA_MUTE_REQUEST,this.dispatchEvent(new N.CustomEvent(n,{composed:!0,bubbles:!0}));break;case`f`:n=this.mediaStore.getState().mediaIsFullscreen?k.MEDIA_EXIT_FULLSCREEN_REQUEST:k.MEDIA_ENTER_FULLSCREEN_REQUEST,this.dispatchEvent(new N.CustomEvent(n,{composed:!0,bubbles:!0}));break;case`c`:this.dispatchEvent(new N.CustomEvent(k.MEDIA_TOGGLE_SUBTITLES_REQUEST,{composed:!0,bubbles:!0}));break;case`ArrowLeft`:case`j`:{let e=this.hasAttribute(U.KEYBOARD_BACKWARD_SEEK_OFFSET)?+this.getAttribute(U.KEYBOARD_BACKWARD_SEEK_OFFSET):xd;r=Math.max((this.mediaStore.getState().mediaCurrentTime??0)-e,0),i=new N.CustomEvent(k.MEDIA_SEEK_REQUEST,{composed:!0,bubbles:!0,detail:r}),this.dispatchEvent(i);break}case`ArrowRight`:case`l`:{let e=this.hasAttribute(U.KEYBOARD_FORWARD_SEEK_OFFSET)?+this.getAttribute(U.KEYBOARD_FORWARD_SEEK_OFFSET):xd;r=Math.max((this.mediaStore.getState().mediaCurrentTime??0)+e,0),i=new N.CustomEvent(k.MEDIA_SEEK_REQUEST,{composed:!0,bubbles:!0,detail:r}),this.dispatchEvent(i);break}case`ArrowUp`:{let e=this.hasAttribute(U.KEYBOARD_UP_VOLUME_STEP)?+this.getAttribute(U.KEYBOARD_UP_VOLUME_STEP):Sd;r=Math.min((this.mediaStore.getState().mediaVolume??1)+e,1),i=new N.CustomEvent(k.MEDIA_VOLUME_REQUEST,{composed:!0,bubbles:!0,detail:r}),this.dispatchEvent(i);break}case`ArrowDown`:{let e=this.hasAttribute(U.KEYBOARD_DOWN_VOLUME_STEP)?+this.getAttribute(U.KEYBOARD_DOWN_VOLUME_STEP):Sd;r=Math.max((this.mediaStore.getState().mediaVolume??1)-e,0),i=new N.CustomEvent(k.MEDIA_VOLUME_REQUEST,{composed:!0,bubbles:!0,detail:r}),this.dispatchEvent(i);break}case`<`:{let e=this.mediaStore.getState().mediaPlaybackRate??1;r=Math.max(e-Cd,wd).toFixed(2),i=new N.CustomEvent(k.MEDIA_PLAYBACK_RATE_REQUEST,{composed:!0,bubbles:!0,detail:r}),this.dispatchEvent(i);break}case`>`:{let e=this.mediaStore.getState().mediaPlaybackRate??1;r=Math.min(e+Cd,Td).toFixed(2),i=new N.CustomEvent(k.MEDIA_PLAYBACK_RATE_REQUEST,{composed:!0,bubbles:!0,detail:r}),this.dispatchEvent(i);break}case`/`:case`?`:e.shiftKey&&rd(this,vd,yd).call(this);break;case`p`:n=this.mediaStore.getState().mediaIsPip?k.MEDIA_EXIT_PIP_REQUEST:k.MEDIA_ENTER_PIP_REQUEST,i=new N.CustomEvent(n,{composed:!0,bubbles:!0}),this.dispatchEvent(i)}}};id=new WeakMap,ad=new WeakMap,H=new WeakMap,od=new WeakMap,sd=new WeakMap,cd=new WeakMap,ld=new WeakMap,ud=new WeakMap,dd=new WeakSet,fd=function(){this.mediaStore=$u({media:this.media,fullscreenElement:this.fullscreenElement,options:{defaultSubtitles:this.hasAttribute(U.DEFAULT_SUBTITLES),defaultDuration:this.hasAttribute(U.DEFAULT_DURATION)?+this.getAttribute(U.DEFAULT_DURATION):void 0,defaultStreamType:this.getAttribute(U.DEFAULT_STREAM_TYPE)??void 0,liveEdgeOffset:this.hasAttribute(U.LIVE_EDGE_OFFSET)?+this.getAttribute(U.LIVE_EDGE_OFFSET):void 0,seekToLiveOffset:this.hasAttribute(U.SEEK_TO_LIVE_OFFSET)?+this.getAttribute(U.SEEK_TO_LIVE_OFFSET):this.hasAttribute(U.LIVE_EDGE_OFFSET)?+this.getAttribute(U.LIVE_EDGE_OFFSET):void 0,noAutoSeekToLive:this.hasAttribute(U.NO_AUTO_SEEK_TO_LIVE),noVolumePref:this.hasAttribute(U.NO_VOLUME_PREF),noMutedPref:this.hasAttribute(U.NO_MUTED_PREF),noSubtitlesLangPref:this.hasAttribute(U.NO_SUBTITLES_LANG_PREF)}})},pd=new WeakMap,md=new WeakSet,hd=function(e){let{metaKey:t,altKey:n,key:r,shiftKey:i}=e,a=i&&(r===`/`||r===`?`);if(a&&V(this,od)?.open||t||n||!a&&!bd.includes(r)){this.removeEventListener(`keyup`,V(this,pd));return}let o=e.target,s=o instanceof HTMLElement&&(o.tagName.toLowerCase()===`media-volume-range`||o.tagName.toLowerCase()===`media-time-range`);[` `,`ArrowLeft`,`ArrowRight`,`ArrowUp`,`ArrowDown`].includes(r)&&!V(this,id).contains(ql(r))&&!s&&e.preventDefault(),this.addEventListener(`keyup`,V(this,pd),{once:!0})},gd=new WeakSet,_d=function(){V(this,od)&&(V(this,od).hotkeys=V(this,id).value||void 0,(this.noHotkeys||V(this,id).contains(`noshift+/`))&&(V(this,od).open=!1))},vd=new WeakSet,yd=function(){V(this,od)||(nd(this,od,sc.createElement(`media-keyboard-shortcuts-dialog`)),rd(this,gd,_d).call(this),this.appendChild(V(this,od))),V(this,od).open=!0};var Dd=Object.values(j),Od=Object.values(bs),kd=e=>{var t;let{observedAttributes:n}=e.constructor;!n&&e.nodeName?.includes(`-`)&&(N.customElements.upgrade(e),{observedAttributes:n}=e.constructor);let r=((t=(e?.getAttribute)?.call(e,A.MEDIA_CHROME_ATTRIBUTES))?.split)?.call(t,/\s+/);return Array.isArray(n||r)?(n||r).filter(e=>Dd.includes(e)):[]},Ad=e=>(e.nodeName?.includes(`-`)&&N.customElements.get(e.nodeName?.toLowerCase())&&!(e instanceof N.customElements.get(e.nodeName.toLowerCase()))&&N.customElements.upgrade(e),Od.some(t=>t in e)),jd=e=>Ad(e)||!!kd(e).length,Md=e=>(e?.join)?.call(e,`:`),Nd={[j.MEDIA_SUBTITLES_LIST]:mu,[j.MEDIA_SUBTITLES_SHOWING]:mu,[j.MEDIA_SEEKABLE]:Md,[j.MEDIA_BUFFERED]:e=>e?.map(Md).join(` `),[j.MEDIA_PREVIEW_COORDS]:e=>e?.join(` `),[j.MEDIA_RENDITION_LIST]:As,[j.MEDIA_AUDIO_TRACK_LIST]:Ps},Pd=async(e,t,n)=>{if(e.isConnected||await Vs(0),typeof n==`boolean`||n==null)return L(e,t,n);if(typeof n==`number`)return F(e,t,n);if(typeof n==`string`)return z(e,t,n);if(Array.isArray(n)&&!n.length)return e.removeAttribute(t);let r=Nd[t]?.call(Nd,n)??n;return e.setAttribute(t,r)},Fd=e=>!!e.closest?.call(e,`*[slot="media"]`),Id=(e,t)=>{if(Fd(e))return;let n=(e,t)=>{jd(e)&&t(e);let{children:n=[]}=e??{},r=e?.shadowRoot?.children??[];[...n,...r].forEach(e=>Id(e,t))},r=e?.nodeName.toLowerCase();r.includes(`-`)&&!jd(e)?N.customElements.whenDefined(r).then(()=>{n(e,t)}):n(e,t)},Ld=(e,t,n)=>{e.forEach(e=>{if(t in e){e[t]=n;return}let r=kd(e),i=t.toLowerCase();r.includes(i)&&Pd(e,i,n)})},Rd=(e,t,n)=>{Id(e,t);let r=e=>{t(e?.composedPath()[0]??e.target)},i=e=>{n(e?.composedPath()[0]??e.target)};e.addEventListener(k.REGISTER_MEDIA_STATE_RECEIVER,r),e.addEventListener(k.UNREGISTER_MEDIA_STATE_RECEIVER,i);let a=e=>{e.forEach(e=>{let{addedNodes:r=[],removedNodes:i=[],type:a,target:o,attributeName:s}=e;a===`childList`?(Array.prototype.forEach.call(r,e=>Id(e,t)),Array.prototype.forEach.call(i,e=>Id(e,n))):a===`attributes`&&s===A.MEDIA_CHROME_ATTRIBUTES&&(jd(o)?t(o):n(o))})},o=[],s=e=>{let r=e.target;r.name!==`media`&&(o.forEach(e=>Id(e,n)),o=[...r.assignedElements({flatten:!0})],o.forEach(e=>Id(e,t)))};e.addEventListener(`slotchange`,s);let c=new MutationObserver(a);return c.observe(e,{childList:!0,attributes:!0,subtree:!0}),()=>{Id(e,n),e.removeEventListener(`slotchange`,s),c.disconnect(),e.removeEventListener(k.REGISTER_MEDIA_STATE_RECEIVER,r),e.removeEventListener(k.UNREGISTER_MEDIA_STATE_RECEIVER,i)}};N.customElements.get(`media-controller`)||N.customElements.define(`media-controller`,Ed);var zd=Ed,Bd={PLACEMENT:`placement`,BOUNDS:`bounds`};function Vd(e){return`
    <style>
      :host {
        --_tooltip-background-color: var(--media-tooltip-background-color, var(--media-secondary-color, rgba(20, 20, 30, .7)));
        --_tooltip-background: var(--media-tooltip-background, var(--_tooltip-background-color));
        --_tooltip-arrow-half-width: calc(var(--media-tooltip-arrow-width, 12px) / 2);
        --_tooltip-arrow-height: var(--media-tooltip-arrow-height, 5px);
        --_tooltip-arrow-background: var(--media-tooltip-arrow-color, var(--_tooltip-background-color));
        position: relative;
        pointer-events: none;
        display: var(--media-tooltip-display, inline-flex);
        justify-content: center;
        align-items: center;
        box-sizing: border-box;
        z-index: var(--media-tooltip-z-index, 1);
        background: var(--_tooltip-background);
        color: var(--media-text-color, var(--media-primary-color, rgb(238 238 238)));
        font: var(--media-font,
          var(--media-font-weight, 400)
          var(--media-font-size, 13px) /
          var(--media-text-content-height, var(--media-control-height, 18px))
          var(--media-font-family, helvetica neue, segoe ui, roboto, arial, sans-serif));
        padding: var(--media-tooltip-padding, .35em .7em);
        border: var(--media-tooltip-border, none);
        border-radius: var(--media-tooltip-border-radius, 5px);
        filter: var(--media-tooltip-filter, drop-shadow(0 0 4px rgba(0, 0, 0, .2)));
        white-space: var(--media-tooltip-white-space, nowrap);
      }

      :host([hidden]) {
        display: none;
      }

      img, svg {
        display: inline-block;
      }

      #arrow {
        position: absolute;
        width: 0px;
        height: 0px;
        border-style: solid;
        display: var(--media-tooltip-arrow-display, block);
      }

      :host(:not([placement])),
      :host([placement="top"]) {
        position: absolute;
        bottom: calc(100% + var(--media-tooltip-distance, 12px));
        left: 50%;
        transform: translate(calc(-50% - var(--media-tooltip-offset-x, 0px)), 0);
      }
      :host(:not([placement])) #arrow,
      :host([placement="top"]) #arrow {
        top: 100%;
        left: 50%;
        border-width: var(--_tooltip-arrow-height) var(--_tooltip-arrow-half-width) 0 var(--_tooltip-arrow-half-width);
        border-color: var(--_tooltip-arrow-background) transparent transparent transparent;
        transform: translate(calc(-50% + var(--media-tooltip-offset-x, 0px)), 0);
      }

      :host([placement="right"]) {
        position: absolute;
        left: calc(100% + var(--media-tooltip-distance, 12px));
        top: 50%;
        transform: translate(0, -50%);
      }
      :host([placement="right"]) #arrow {
        top: 50%;
        right: 100%;
        border-width: var(--_tooltip-arrow-half-width) var(--_tooltip-arrow-height) var(--_tooltip-arrow-half-width) 0;
        border-color: transparent var(--_tooltip-arrow-background) transparent transparent;
        transform: translate(0, -50%);
      }

      :host([placement="bottom"]) {
        position: absolute;
        top: calc(100% + var(--media-tooltip-distance, 12px));
        left: 50%;
        transform: translate(calc(-50% - var(--media-tooltip-offset-x, 0px)), 0);
      }
      :host([placement="bottom"]) #arrow {
        bottom: 100%;
        left: 50%;
        border-width: 0 var(--_tooltip-arrow-half-width) var(--_tooltip-arrow-height) var(--_tooltip-arrow-half-width);
        border-color: transparent transparent var(--_tooltip-arrow-background) transparent;
        transform: translate(calc(-50% + var(--media-tooltip-offset-x, 0px)), 0);
      }

      :host([placement="left"]) {
        position: absolute;
        right: calc(100% + var(--media-tooltip-distance, 12px));
        top: 50%;
        transform: translate(0, -50%);
      }
      :host([placement="left"]) #arrow {
        top: 50%;
        left: 100%;
        border-width: var(--_tooltip-arrow-half-width) 0 var(--_tooltip-arrow-half-width) var(--_tooltip-arrow-height);
        border-color: transparent transparent transparent var(--_tooltip-arrow-background);
        transform: translate(0, -50%);
      }
      
      :host([placement="none"]) #arrow {
        display: none;
      }
    </style>
    <slot></slot>
    <div id="arrow"></div>
  `}var Hd=class extends N.HTMLElement{constructor(){if(super(),this.updateXOffset=()=>{if(!Cc(this,{checkOpacity:!1,checkVisibilityCSS:!1}))return;let e=this.placement;if(e===`left`||e===`right`){this.style.removeProperty(`--media-tooltip-offset-x`);return}let t=getComputedStyle(this),n=bc(this,`#`+this.bounds)??mc(this);if(!n)return;let{x:r,width:i}=n.getBoundingClientRect(),{x:a,width:o}=this.getBoundingClientRect(),s=a+o,c=r+i,l=t.getPropertyValue(`--media-tooltip-offset-x`),u=l?parseFloat(l.replace(`px`,``)):0,d=t.getPropertyValue(`--media-tooltip-container-margin`),f=d?parseFloat(d.replace(`px`,``)):0,p=a-r+u-f,m=s-c+u+f;p<0?this.style.setProperty(`--media-tooltip-offset-x`,`${p}px`):m>0?this.style.setProperty(`--media-tooltip-offset-x`,`${m}px`):this.style.removeProperty(`--media-tooltip-offset-x`)},!this.shadowRoot){this.attachShadow(this.constructor.shadowRootOptions);let e=pc(this.attributes);this.shadowRoot.innerHTML=this.constructor.getTemplateHTML(e)}if(this.arrowEl=this.shadowRoot.querySelector(`#arrow`),Object.prototype.hasOwnProperty.call(this,`placement`)){let e=this.placement;delete this.placement,this.placement=e}}static get observedAttributes(){return[Bd.PLACEMENT,Bd.BOUNDS]}get placement(){return R(this,Bd.PLACEMENT)}set placement(e){z(this,Bd.PLACEMENT,e)}get bounds(){return R(this,Bd.BOUNDS)}set bounds(e){z(this,Bd.BOUNDS,e)}};Hd.shadowRootOptions={mode:`open`},Hd.getTemplateHTML=Vd,N.customElements.get(`media-tooltip`)||N.customElements.define(`media-tooltip`,Hd);var Ud=Hd,Wd=(e,t,n)=>{if(!t.has(e))throw TypeError(`Cannot `+n)},Gd=(e,t,n)=>(Wd(e,t,`read from private field`),n?n.call(e):t.get(e)),Kd=(e,t,n)=>{if(t.has(e))throw TypeError(`Cannot add the same private member more than once`);t instanceof WeakSet?t.add(e):t.set(e,n)},qd=(e,t,n,r)=>(Wd(e,t,`write to private field`),r?r.call(e,n):t.set(e,n),n),Jd=(e,t,n)=>(Wd(e,t,`access private method`),n),Yd,Xd,Zd,Qd,$d,ef,tf,nf,rf,af={TOOLTIP_PLACEMENT:`tooltipplacement`,DISABLED:`disabled`,NO_TOOLTIP:`notooltip`};function of(e,t={}){return`
    <style>
      :host {
        position: relative;
        font: var(--media-font,
          var(--media-font-weight, bold)
          var(--media-font-size, 14px) /
          var(--media-text-content-height, var(--media-control-height, 24px))
          var(--media-font-family, helvetica neue, segoe ui, roboto, arial, sans-serif));
        color: var(--media-text-color, var(--media-primary-color, rgb(238 238 238)));
        background: var(--media-control-background, var(--media-secondary-color, rgb(20 20 30 / .7)));
        padding: var(--media-button-padding, var(--media-control-padding, 10px));
        justify-content: var(--media-button-justify-content, center);
        display: inline-flex;
        align-items: center;
        vertical-align: middle;
        box-sizing: border-box;
        transition: background .15s linear;
        pointer-events: auto;
        cursor: var(--media-cursor, pointer);
        -webkit-tap-highlight-color: transparent;
      }

      
      :host(:focus-visible) {
        box-shadow: var(--media-focus-box-shadow, inset 0 0 0 2px rgb(27 127 204 / .9));
        outline: 0;
      }
      
      :host(:where(:focus)) {
        box-shadow: none;
        outline: 0;
      }

      :host(:hover) {
        background: var(--media-control-hover-background, rgba(50 50 70 / .7));
      }

      slot[name="icon"] {
        display: inline-flex;
        align-items: center;
      }

      svg, img, ::slotted(svg), ::slotted(img) {
        width: var(--media-button-icon-width);
        height: var(--media-button-icon-height, var(--media-control-height, 24px));
        transform: var(--media-button-icon-transform);
        transition: var(--media-button-icon-transition);
        fill: var(--media-icon-color, var(--media-primary-color, rgb(238 238 238)));
        vertical-align: middle;
        max-width: 100%;
        max-height: 100%;
        min-width: 100%;
      }

      media-tooltip {
        
        max-width: 0;
        overflow-x: clip;
        opacity: 0;
        transition: opacity .3s, max-width 0s 9s;
      }

      :host(:hover) media-tooltip,
      :host(:focus-visible) media-tooltip {
        max-width: 100vw;
        opacity: 1;
        transition: opacity .3s;
      }

      :host([notooltip]) slot[name="tooltip"] {
        display: none;
      }
    </style>

    ${this.getSlotTemplateHTML(e,t)}

    <slot name="tooltip">
      <media-tooltip part="tooltip" aria-hidden="true">
        <template shadowrootmode="${Ud.shadowRootOptions.mode}">
          ${Ud.getTemplateHTML({})}
        </template>
        <slot name="tooltip-content">
          ${this.getTooltipContentHTML(e)}
        </slot>
      </media-tooltip>
    </slot>
  `}function sf(e,t){return`
    <slot></slot>
  `}function cf(){return``}var lf=class extends N.HTMLElement{constructor(){if(super(),Kd(this,Zd),Kd(this,nf),Kd(this,Yd,void 0),this.preventClick=!1,this.tooltipEl=null,Kd(this,Xd,e=>{this.preventClick||this.handleClick(e),setTimeout(Gd(this,$d),0)}),Kd(this,$d,()=>{var e,t;(t=(e=this.tooltipEl)?.updateXOffset)==null||t.call(e)}),Kd(this,ef,e=>{let{key:t}=e;this.keysUsed.includes(t)?this.preventClick||this.handleClick(e):this.removeEventListener(`keyup`,Gd(this,ef))}),Kd(this,tf,e=>{let{metaKey:t,altKey:n,key:r}=e;t||n||!this.keysUsed.includes(r)?this.removeEventListener(`keyup`,Gd(this,ef)):this.addEventListener(`keyup`,Gd(this,ef),{once:!0})}),!this.shadowRoot){this.attachShadow(this.constructor.shadowRootOptions);let e=pc(this.attributes),t=this.constructor.getTemplateHTML(e);this.shadowRoot.setHTMLUnsafe?this.shadowRoot.setHTMLUnsafe(t):this.shadowRoot.innerHTML=t}this.tooltipEl=this.shadowRoot.querySelector(`media-tooltip`)}static get observedAttributes(){return[`disabled`,af.TOOLTIP_PLACEMENT,A.MEDIA_CONTROLLER,j.MEDIA_LANG]}enable(){this.addEventListener(`click`,Gd(this,Xd)),this.addEventListener(`keydown`,Gd(this,tf)),this.tabIndex=0}disable(){this.removeEventListener(`click`,Gd(this,Xd)),this.removeEventListener(`keydown`,Gd(this,tf)),this.removeEventListener(`keyup`,Gd(this,ef)),this.tabIndex=-1}attributeChangedCallback(e,t,n){var r,i,a,o;e===A.MEDIA_CONTROLLER?(t&&((i=(r=Gd(this,Yd))?.unassociateElement)==null||i.call(r,this),qd(this,Yd,null)),n&&this.isConnected&&(qd(this,Yd,this.getRootNode()?.getElementById(n)),(o=(a=Gd(this,Yd))?.associateElement)==null||o.call(a,this))):e===`disabled`&&n!==t?n==null?this.enable():this.disable():e===af.TOOLTIP_PLACEMENT&&this.tooltipEl&&n!==t?this.tooltipEl.placement=n:e===j.MEDIA_LANG&&(this.shadowRoot.querySelector(`slot[name="tooltip-content"]`).innerHTML=this.constructor.getTooltipContentHTML()),Jd(this,Zd,Qd).call(this)&&Gd(this,$d).call(this)}connectedCallback(){var e,t;let{style:n}=Tc(this.shadowRoot,`:host`);n.setProperty(`display`,`var(--media-control-display, var(--${this.localName}-display, inline-flex))`),this.hasAttribute(`disabled`)?this.disable():this.enable(),this.setAttribute(`role`,`button`);let r=this.getAttribute(A.MEDIA_CONTROLLER);r&&(qd(this,Yd,this.getRootNode()?.getElementById(r)),(t=(e=Gd(this,Yd))?.associateElement)==null||t.call(e,this)),N.customElements.whenDefined(`media-tooltip`).then(()=>Jd(this,nf,rf).call(this))}disconnectedCallback(){var e,t;this.disable(),(t=(e=Gd(this,Yd))?.unassociateElement)==null||t.call(e,this),qd(this,Yd,null),this.removeEventListener(`mouseenter`,Gd(this,$d)),this.removeEventListener(`focus`,Gd(this,$d)),this.removeEventListener(`click`,Gd(this,Xd))}get keysUsed(){return[`Enter`,` `]}get tooltipPlacement(){return R(this,af.TOOLTIP_PLACEMENT)}set tooltipPlacement(e){z(this,af.TOOLTIP_PLACEMENT,e)}get mediaController(){return R(this,A.MEDIA_CONTROLLER)}set mediaController(e){z(this,A.MEDIA_CONTROLLER,e)}get disabled(){return I(this,af.DISABLED)}set disabled(e){L(this,af.DISABLED,e)}get noTooltip(){return I(this,af.NO_TOOLTIP)}set noTooltip(e){L(this,af.NO_TOOLTIP,e)}handleClick(e){}};Yd=new WeakMap,Xd=new WeakMap,Zd=new WeakSet,Qd=function(){try{return this.matches(`:hover, :focus-visible`)}catch{return this.matches(`:hover, :focus`)}},$d=new WeakMap,ef=new WeakMap,tf=new WeakMap,nf=new WeakSet,rf=function(){this.addEventListener(`mouseenter`,Gd(this,$d)),this.addEventListener(`focus`,Gd(this,$d)),this.addEventListener(`click`,Gd(this,Xd));let e=this.tooltipPlacement;e&&this.tooltipEl&&(this.tooltipEl.placement=e)},lf.shadowRootOptions={mode:`open`},lf.getTemplateHTML=of,lf.getSlotTemplateHTML=sf,lf.getTooltipContentHTML=cf,N.customElements.get(`media-chrome-button`)||N.customElements.define(`media-chrome-button`,lf);var uf=`<svg aria-hidden="true" viewBox="0 0 26 24">
  <path d="M22.13 3H3.87a.87.87 0 0 0-.87.87v13.26a.87.87 0 0 0 .87.87h3.4L9 16H5V5h16v11h-4l1.72 2h3.4a.87.87 0 0 0 .87-.87V3.87a.87.87 0 0 0-.86-.87Zm-8.75 11.44a.5.5 0 0 0-.76 0l-4.91 5.73a.5.5 0 0 0 .38.83h9.82a.501.501 0 0 0 .38-.83l-4.91-5.73Z"/>
</svg>
`;function df(e){return`
    <style>
      :host([${j.MEDIA_IS_AIRPLAYING}]) slot[name=icon] slot:not([name=exit]) {
        display: none !important;
      }

      
      :host(:not([${j.MEDIA_IS_AIRPLAYING}])) slot[name=icon] slot:not([name=enter]) {
        display: none !important;
      }

      :host([${j.MEDIA_IS_AIRPLAYING}]) slot[name=tooltip-enter],
      :host(:not([${j.MEDIA_IS_AIRPLAYING}])) slot[name=tooltip-exit] {
        display: none;
      }
    </style>

    <slot name="icon">
      <slot name="enter">${uf}</slot>
      <slot name="exit">${uf}</slot>
    </slot>
  `}function ff(){return`
    <slot name="tooltip-enter">${M(`start airplay`)}</slot>
    <slot name="tooltip-exit">${M(`stop airplay`)}</slot>
  `}var pf=e=>{let t=e.mediaIsAirplaying?M(`stop airplay`):M(`start airplay`);e.setAttribute(`aria-label`,t)},mf=class extends lf{static get observedAttributes(){return[...super.observedAttributes,j.MEDIA_IS_AIRPLAYING,j.MEDIA_AIRPLAY_UNAVAILABLE]}connectedCallback(){super.connectedCallback(),pf(this)}attributeChangedCallback(e,t,n){super.attributeChangedCallback(e,t,n),e===j.MEDIA_IS_AIRPLAYING&&pf(this)}get mediaIsAirplaying(){return I(this,j.MEDIA_IS_AIRPLAYING)}set mediaIsAirplaying(e){L(this,j.MEDIA_IS_AIRPLAYING,e)}get mediaAirplayUnavailable(){return R(this,j.MEDIA_AIRPLAY_UNAVAILABLE)}set mediaAirplayUnavailable(e){z(this,j.MEDIA_AIRPLAY_UNAVAILABLE,e)}handleClick(){let e=new N.CustomEvent(k.MEDIA_AIRPLAY_REQUEST,{composed:!0,bubbles:!0});this.dispatchEvent(e)}};mf.getSlotTemplateHTML=df,mf.getTooltipContentHTML=ff,N.customElements.get(`media-airplay-button`)||N.customElements.define(`media-airplay-button`,mf);var hf=`<svg aria-hidden="true" viewBox="0 0 26 24">
  <path d="M22.83 5.68a2.58 2.58 0 0 0-2.3-2.5c-3.62-.24-11.44-.24-15.06 0a2.58 2.58 0 0 0-2.3 2.5c-.23 4.21-.23 8.43 0 12.64a2.58 2.58 0 0 0 2.3 2.5c3.62.24 11.44.24 15.06 0a2.58 2.58 0 0 0 2.3-2.5c.23-4.21.23-8.43 0-12.64Zm-11.39 9.45a3.07 3.07 0 0 1-1.91.57 3.06 3.06 0 0 1-2.34-1 3.75 3.75 0 0 1-.92-2.67 3.92 3.92 0 0 1 .92-2.77 3.18 3.18 0 0 1 2.43-1 2.94 2.94 0 0 1 2.13.78c.364.359.62.813.74 1.31l-1.43.35a1.49 1.49 0 0 0-1.51-1.17 1.61 1.61 0 0 0-1.29.58 2.79 2.79 0 0 0-.5 1.89 3 3 0 0 0 .49 1.93 1.61 1.61 0 0 0 1.27.58 1.48 1.48 0 0 0 1-.37 2.1 2.1 0 0 0 .59-1.14l1.4.44a3.23 3.23 0 0 1-1.07 1.69Zm7.22 0a3.07 3.07 0 0 1-1.91.57 3.06 3.06 0 0 1-2.34-1 3.75 3.75 0 0 1-.92-2.67 3.88 3.88 0 0 1 .93-2.77 3.14 3.14 0 0 1 2.42-1 3 3 0 0 1 2.16.82 2.8 2.8 0 0 1 .73 1.31l-1.43.35a1.49 1.49 0 0 0-1.51-1.21 1.61 1.61 0 0 0-1.29.58A2.79 2.79 0 0 0 15 12a3 3 0 0 0 .49 1.93 1.61 1.61 0 0 0 1.27.58 1.44 1.44 0 0 0 1-.37 2.1 2.1 0 0 0 .6-1.15l1.4.44a3.17 3.17 0 0 1-1.1 1.7Z"/>
</svg>`,gf=`<svg aria-hidden="true" viewBox="0 0 26 24">
  <path d="M17.73 14.09a1.4 1.4 0 0 1-1 .37 1.579 1.579 0 0 1-1.27-.58A3 3 0 0 1 15 12a2.8 2.8 0 0 1 .5-1.85 1.63 1.63 0 0 1 1.29-.57 1.47 1.47 0 0 1 1.51 1.2l1.43-.34A2.89 2.89 0 0 0 19 9.07a3 3 0 0 0-2.14-.78 3.14 3.14 0 0 0-2.42 1 3.91 3.91 0 0 0-.93 2.78 3.74 3.74 0 0 0 .92 2.66 3.07 3.07 0 0 0 2.34 1 3.07 3.07 0 0 0 1.91-.57 3.17 3.17 0 0 0 1.07-1.74l-1.4-.45c-.083.43-.3.822-.62 1.12Zm-7.22 0a1.43 1.43 0 0 1-1 .37 1.58 1.58 0 0 1-1.27-.58A3 3 0 0 1 7.76 12a2.8 2.8 0 0 1 .5-1.85 1.63 1.63 0 0 1 1.29-.57 1.47 1.47 0 0 1 1.51 1.2l1.43-.34a2.81 2.81 0 0 0-.74-1.32 2.94 2.94 0 0 0-2.13-.78 3.18 3.18 0 0 0-2.43 1 4 4 0 0 0-.92 2.78 3.74 3.74 0 0 0 .92 2.66 3.07 3.07 0 0 0 2.34 1 3.07 3.07 0 0 0 1.91-.57 3.23 3.23 0 0 0 1.07-1.74l-1.4-.45a2.06 2.06 0 0 1-.6 1.07Zm12.32-8.41a2.59 2.59 0 0 0-2.3-2.51C18.72 3.05 15.86 3 13 3c-2.86 0-5.72.05-7.53.17a2.59 2.59 0 0 0-2.3 2.51c-.23 4.207-.23 8.423 0 12.63a2.57 2.57 0 0 0 2.3 2.5c1.81.13 4.67.19 7.53.19 2.86 0 5.72-.06 7.53-.19a2.57 2.57 0 0 0 2.3-2.5c.23-4.207.23-8.423 0-12.63Zm-1.49 12.53a1.11 1.11 0 0 1-.91 1.11c-1.67.11-4.45.18-7.43.18-2.98 0-5.76-.07-7.43-.18a1.11 1.11 0 0 1-.91-1.11c-.21-4.14-.21-8.29 0-12.43a1.11 1.11 0 0 1 .91-1.11C7.24 4.56 10 4.49 13 4.49s5.76.07 7.43.18a1.11 1.11 0 0 1 .91 1.11c.21 4.14.21 8.29 0 12.43Z"/>
</svg>`;function _f(e){return`
    <style>
      :host([aria-checked="true"]) slot[name=off] {
        display: none !important;
      }

      
      :host(:not([aria-checked="true"])) slot[name=on] {
        display: none !important;
      }

      :host([aria-checked="true"]) slot[name=tooltip-enable],
      :host(:not([aria-checked="true"])) slot[name=tooltip-disable] {
        display: none;
      }
    </style>

    <slot name="icon">
      <slot name="on">${hf}</slot>
      <slot name="off">${gf}</slot>
    </slot>
  `}function vf(){return`
    <slot name="tooltip-enable">${M(`Enable captions`)}</slot>
    <slot name="tooltip-disable">${M(`Disable captions`)}</slot>
  `}var yf=e=>{e.setAttribute(`aria-checked`,yu(e).toString())},bf=class extends lf{static get observedAttributes(){return[...super.observedAttributes,j.MEDIA_SUBTITLES_LIST,j.MEDIA_SUBTITLES_SHOWING]}connectedCallback(){super.connectedCallback(),this.setAttribute(`role`,`button`),this.setAttribute(`aria-label`,M(`closed captions`)),yf(this)}attributeChangedCallback(e,t,n){super.attributeChangedCallback(e,t,n),e===j.MEDIA_SUBTITLES_SHOWING&&yf(this)}get mediaSubtitlesList(){return xf(this,j.MEDIA_SUBTITLES_LIST)}set mediaSubtitlesList(e){Sf(this,j.MEDIA_SUBTITLES_LIST,e)}get mediaSubtitlesShowing(){return xf(this,j.MEDIA_SUBTITLES_SHOWING)}set mediaSubtitlesShowing(e){Sf(this,j.MEDIA_SUBTITLES_SHOWING,e)}handleClick(){this.dispatchEvent(new N.CustomEvent(k.MEDIA_TOGGLE_SUBTITLES_REQUEST,{composed:!0,bubbles:!0}))}};bf.getSlotTemplateHTML=_f,bf.getTooltipContentHTML=vf;var xf=(e,t)=>{let n=e.getAttribute(t);return n?du(n):[]},Sf=(e,t,n)=>{if(!n?.length){e.removeAttribute(t);return}let r=mu(n);e.getAttribute(t)!==r&&e.setAttribute(t,r)};N.customElements.get(`media-captions-button`)||N.customElements.define(`media-captions-button`,bf);var Cf=`<svg aria-hidden="true" viewBox="0 0 24 24"><g><path class="cast_caf_icon_arch0" d="M1,18 L1,21 L4,21 C4,19.3 2.66,18 1,18 L1,18 Z"/><path class="cast_caf_icon_arch1" d="M1,14 L1,16 C3.76,16 6,18.2 6,21 L8,21 C8,17.13 4.87,14 1,14 L1,14 Z"/><path class="cast_caf_icon_arch2" d="M1,10 L1,12 C5.97,12 10,16.0 10,21 L12,21 C12,14.92 7.07,10 1,10 L1,10 Z"/><path class="cast_caf_icon_box" d="M21,3 L3,3 C1.9,3 1,3.9 1,5 L1,8 L3,8 L3,5 L21,5 L21,19 L14,19 L14,21 L21,21 C22.1,21 23,20.1 23,19 L23,5 C23,3.9 22.1,3 21,3 L21,3 Z"/></g></svg>`,wf=`<svg aria-hidden="true" viewBox="0 0 24 24"><g><path class="cast_caf_icon_arch0" d="M1,18 L1,21 L4,21 C4,19.3 2.66,18 1,18 L1,18 Z"/><path class="cast_caf_icon_arch1" d="M1,14 L1,16 C3.76,16 6,18.2 6,21 L8,21 C8,17.13 4.87,14 1,14 L1,14 Z"/><path class="cast_caf_icon_arch2" d="M1,10 L1,12 C5.97,12 10,16.0 10,21 L12,21 C12,14.92 7.07,10 1,10 L1,10 Z"/><path class="cast_caf_icon_box" d="M21,3 L3,3 C1.9,3 1,3.9 1,5 L1,8 L3,8 L3,5 L21,5 L21,19 L14,19 L14,21 L21,21 C22.1,21 23,20.1 23,19 L23,5 C23,3.9 22.1,3 21,3 L21,3 Z"/><path class="cast_caf_icon_boxfill" d="M5,7 L5,8.63 C8,8.6 13.37,14 13.37,17 L19,17 L19,7 Z"/></g></svg>`;function Tf(e){return`
    <style>
      :host([${j.MEDIA_IS_CASTING}]) slot[name=icon] slot:not([name=exit]) {
        display: none !important;
      }

      
      :host(:not([${j.MEDIA_IS_CASTING}])) slot[name=icon] slot:not([name=enter]) {
        display: none !important;
      }

      :host([${j.MEDIA_IS_CASTING}]) slot[name=tooltip-enter],
      :host(:not([${j.MEDIA_IS_CASTING}])) slot[name=tooltip-exit] {
        display: none;
      }
    </style>

    <slot name="icon">
      <slot name="enter">${Cf}</slot>
      <slot name="exit">${wf}</slot>
    </slot>
  `}function Ef(){return`
    <slot name="tooltip-enter">${M(`Start casting`)}</slot>
    <slot name="tooltip-exit">${M(`Stop casting`)}</slot>
  `}var Df=e=>{let t=e.mediaIsCasting?M(`stop casting`):M(`start casting`);e.setAttribute(`aria-label`,t)},Of=class extends lf{static get observedAttributes(){return[...super.observedAttributes,j.MEDIA_IS_CASTING,j.MEDIA_CAST_UNAVAILABLE]}connectedCallback(){super.connectedCallback(),Df(this)}attributeChangedCallback(e,t,n){super.attributeChangedCallback(e,t,n),e===j.MEDIA_IS_CASTING&&Df(this)}get mediaIsCasting(){return I(this,j.MEDIA_IS_CASTING)}set mediaIsCasting(e){L(this,j.MEDIA_IS_CASTING,e)}get mediaCastUnavailable(){return R(this,j.MEDIA_CAST_UNAVAILABLE)}set mediaCastUnavailable(e){z(this,j.MEDIA_CAST_UNAVAILABLE,e)}handleClick(){let e=this.mediaIsCasting?k.MEDIA_EXIT_CAST_REQUEST:k.MEDIA_ENTER_CAST_REQUEST;this.dispatchEvent(new N.CustomEvent(e,{composed:!0,bubbles:!0}))}};Of.getSlotTemplateHTML=Tf,Of.getTooltipContentHTML=Ef,N.customElements.get(`media-cast-button`)||N.customElements.define(`media-cast-button`,Of);var kf=(e,t,n)=>{if(!t.has(e))throw TypeError(`Cannot `+n)},W=(e,t,n)=>(kf(e,t,`read from private field`),n?n.call(e):t.get(e)),Af=(e,t,n)=>{if(t.has(e))throw TypeError(`Cannot add the same private member more than once`);t instanceof WeakSet?t.add(e):t.set(e,n)},jf=(e,t,n,r)=>(kf(e,t,`write to private field`),r?r.call(e,n):t.set(e,n),n),Mf=(e,t,n)=>(kf(e,t,`access private method`),n),Nf,Pf,Ff,If,Lf,Rf,zf,Bf,Vf,Hf,Uf,Wf,Gf,Kf,qf,Jf,Yf,Xf,Zf,Qf,$f,ep,tp,np,rp;function ip(e){return`
    <style>
      :host {
        --_focus-box-shadow: var(--media-focus-box-shadow, inset 0 0 0 2px rgb(27 127 204 / .9));
        --_media-range-padding: var(--media-range-padding, var(--media-control-padding, 10px));

        box-shadow: var(--_focus-visible-box-shadow, none);
        background: var(--media-control-background, var(--media-secondary-color, rgb(20 20 30 / .7)));
        height: calc(var(--media-control-height, 24px) + 2 * var(--_media-range-padding));
        display: inline-flex;
        align-items: center;
        
        vertical-align: middle;
        box-sizing: border-box;
        position: relative;
        width: 100px;
        transition: background .15s linear;
        cursor: var(--media-cursor, pointer);
        pointer-events: auto;
        touch-action: none; 
      }

      
      input[type=range]:focus {
        outline: 0;
      }
      input[type=range]:focus::-webkit-slider-runnable-track {
        outline: 0;
      }

      :host(:hover) {
        background: var(--media-control-hover-background, rgb(50 50 70 / .7));
      }

      #leftgap {
        padding-left: var(--media-range-padding-left, var(--_media-range-padding));
      }

      #rightgap {
        padding-right: var(--media-range-padding-right, var(--_media-range-padding));
      }

      #startpoint,
      #endpoint {
        position: absolute;
      }

      #endpoint {
        right: 0;
      }

      #container {
        
        width: var(--media-range-track-width, 100%);
        transform: translate(var(--media-range-track-translate-x, 0px), var(--media-range-track-translate-y, 0px));
        position: relative;
        height: 100%;
        display: flex;
        align-items: center;
        min-width: 40px;
      }

      #range {
        
        display: var(--media-time-range-hover-display, block);
        bottom: var(--media-time-range-hover-bottom, 0);
        height: var(--media-time-range-hover-height, max(100% , 25px));
        width: 100%;
        position: absolute;
        cursor: var(--media-cursor, pointer);

        -webkit-appearance: none; 
        -webkit-tap-highlight-color: transparent;
        background: transparent; 
        margin: 0;
        z-index: 1;
      }

      @media (hover: hover) {
        #range {
          bottom: var(--media-time-range-hover-bottom, 0);
          height: var(--media-time-range-hover-height, max(100%, 20px));
        }
      }

      
      
      #range::-webkit-slider-thumb {
        -webkit-appearance: none;
        background: transparent;
        width: .1px;
        height: .1px;
      }

      
      #range::-moz-range-thumb {
        background: transparent;
        border: transparent;
        width: .1px;
        height: .1px;
      }

      #appearance {
        height: var(--media-range-track-height, 4px);
        display: flex;
        flex-direction: column;
        justify-content: center;
        width: 100%;
        position: absolute;
        
        will-change: transform;
      }

      #track {
        background: var(--media-range-track-background, rgb(255 255 255 / .2));
        border-radius: var(--media-range-track-border-radius, 1px);
        border: var(--media-range-track-border, none);
        outline: var(--media-range-track-outline);
        outline-offset: var(--media-range-track-outline-offset);
        backdrop-filter: var(--media-range-track-backdrop-filter);
        -webkit-backdrop-filter: var(--media-range-track-backdrop-filter);
        box-shadow: var(--media-range-track-box-shadow, none);
        position: absolute;
        width: 100%;
        height: 100%;
        overflow: hidden;
      }

      #progress,
      #pointer {
        position: absolute;
        height: 100%;
        will-change: width;
      }

      #progress {
        background: var(--media-range-bar-color, var(--media-primary-color, rgb(238 238 238)));
        transition: var(--media-range-track-transition);
      }

      #pointer {
        background: var(--media-range-track-pointer-background);
        border-right: var(--media-range-track-pointer-border-right);
        transition: visibility .25s, opacity .25s;
        visibility: hidden;
        opacity: 0;
      }

      @media (hover: hover) {
        :host(:hover) #pointer {
          transition: visibility .5s, opacity .5s;
          visibility: visible;
          opacity: 1;
        }
      }

      #thumb,
      ::slotted([slot=thumb]) {
        width: var(--media-range-thumb-width, 10px);
        height: var(--media-range-thumb-height, 10px);
        transition: var(--media-range-thumb-transition);
        transform: var(--media-range-thumb-transform, none);
        opacity: var(--media-range-thumb-opacity, 1);
        translate: -50%;
        position: absolute;
        left: 0;
        cursor: var(--media-cursor, pointer);
      }

      #thumb {
        border-radius: var(--media-range-thumb-border-radius, 10px);
        background: var(--media-range-thumb-background, var(--media-primary-color, rgb(238 238 238)));
        box-shadow: var(--media-range-thumb-box-shadow, 1px 1px 1px transparent);
        border: var(--media-range-thumb-border, none);
      }

      :host([disabled]) #thumb {
        background-color: #777;
      }

      .segments #appearance {
        height: var(--media-range-segment-hover-height, 7px);
      }

      #track {
        clip-path: url(#segments-clipping);
      }

      #segments {
        --segments-gap: var(--media-range-segments-gap, 2px);
        position: absolute;
        width: 100%;
        height: 100%;
      }

      #segments-clipping {
        transform: translateX(calc(var(--segments-gap) / 2));
      }

      #segments-clipping:empty {
        display: none;
      }

      #segments-clipping rect {
        height: var(--media-range-track-height, 4px);
        y: calc((var(--media-range-segment-hover-height, 7px) - var(--media-range-track-height, 4px)) / 2);
        transition: var(--media-range-segment-transition, transform .1s ease-in-out);
        transform: var(--media-range-segment-transform, scaleY(1));
        transform-origin: center;
      }

      /* Visible label for accessibility - positioned off-screen but technically visible (Firefox requires visible labels) */
      #range-label {
        position: absolute;
        left: -10000px;
        background: var(--media-control-background, var(--media-secondary-color, rgb(20 20 30 / .7)));
        pointer-events: none;
      }
    </style>
    <div id="leftgap"></div>
    <div id="container">
      <div id="startpoint"></div>
      <div id="endpoint"></div>
      <div id="appearance">
        <div id="track" part="track">
          <div id="pointer"></div>
          <div id="progress" part="progress"></div>
        </div>
        <slot name="thumb">
          <div id="thumb" part="thumb"></div>
        </slot>
        <svg id="segments" aria-hidden="true"><clipPath id="segments-clipping"></clipPath></svg>
      </div>
        <input id="range" type="range" min="0" max="1" step="any" value="0">
        <label for="range" id="range-label"></label>

      ${this.getContainerTemplateHTML(e)}
    </div>
    <div id="rightgap"></div>
  `}function ap(e){return``}var op=class extends N.HTMLElement{constructor(){if(super(),Af(this,Hf),Af(this,Wf),Af(this,Kf),Af(this,Jf),Af(this,Xf),Af(this,Qf),Af(this,ep),Af(this,np),Af(this,Nf,void 0),Af(this,Pf,void 0),Af(this,Ff,void 0),Af(this,If,void 0),Af(this,Lf,{}),Af(this,Rf,[]),Af(this,zf,()=>{if(this.range.matches(`:focus-visible`)){let{style:e}=Tc(this.shadowRoot,`:host`);e.setProperty(`--_focus-visible-box-shadow`,`var(--_focus-box-shadow)`)}}),Af(this,Bf,()=>{let{style:e}=Tc(this.shadowRoot,`:host`);e.removeProperty(`--_focus-visible-box-shadow`)}),Af(this,Vf,()=>{let e=this.shadowRoot.querySelector(`#segments-clipping`);e&&e.parentNode.append(e)}),!this.shadowRoot){this.attachShadow(this.constructor.shadowRootOptions);let e=pc(this.attributes),t=this.constructor.getTemplateHTML(e);this.shadowRoot.setHTMLUnsafe?this.shadowRoot.setHTMLUnsafe(t):this.shadowRoot.innerHTML=t}this.container=this.shadowRoot.querySelector(`#container`),jf(this,Ff,this.shadowRoot.querySelector(`#startpoint`)),jf(this,If,this.shadowRoot.querySelector(`#endpoint`)),this.range=this.shadowRoot.querySelector(`#range`),this.appearance=this.shadowRoot.querySelector(`#appearance`)}static get observedAttributes(){return[`disabled`,`aria-disabled`,A.MEDIA_CONTROLLER]}attributeChangedCallback(e,t,n){var r,i,a,o;e===A.MEDIA_CONTROLLER?(t&&((i=(r=W(this,Nf))?.unassociateElement)==null||i.call(r,this),jf(this,Nf,null)),n&&this.isConnected&&(jf(this,Nf,this.getRootNode()?.getElementById(n)),(o=(a=W(this,Nf))?.associateElement)==null||o.call(a,this))):(e===`disabled`||e===`aria-disabled`&&t!==n)&&(n==null?(this.range.removeAttribute(e),Mf(this,Wf,Gf).call(this)):(this.range.setAttribute(e,n),Mf(this,Kf,qf).call(this)))}connectedCallback(){var e,t;let{style:n}=Tc(this.shadowRoot,`:host`);n.setProperty(`display`,`var(--media-control-display, var(--${this.localName}-display, inline-flex))`),W(this,Lf).pointer=Tc(this.shadowRoot,`#pointer`),W(this,Lf).progress=Tc(this.shadowRoot,`#progress`),W(this,Lf).thumb=Tc(this.shadowRoot,`#thumb, ::slotted([slot="thumb"])`),W(this,Lf).activeSegment=Tc(this.shadowRoot,`#segments-clipping rect:nth-child(0)`);let r=this.getAttribute(A.MEDIA_CONTROLLER);r&&(jf(this,Nf,this.getRootNode()?.getElementById(r)),(t=(e=W(this,Nf))?.associateElement)==null||t.call(e,this)),this.updateBar(),this.shadowRoot.addEventListener(`focusin`,W(this,zf)),this.shadowRoot.addEventListener(`focusout`,W(this,Bf)),Mf(this,Wf,Gf).call(this),dc(this.container,W(this,Vf))}disconnectedCallback(){var e,t;Mf(this,Kf,qf).call(this),(t=(e=W(this,Nf))?.unassociateElement)==null||t.call(e,this),jf(this,Nf,null),this.shadowRoot.removeEventListener(`focusin`,W(this,zf)),this.shadowRoot.removeEventListener(`focusout`,W(this,Bf)),fc(this.container,W(this,Vf))}updatePointerBar(e){var t;(t=W(this,Lf).pointer)==null||t.style.setProperty(`width`,`${this.getPointerRatio(e)*100}%`)}updateBar(){var e,t;let n=this.range.valueAsNumber*100;(e=W(this,Lf).progress)==null||e.style.setProperty(`width`,`${n}%`),(t=W(this,Lf).thumb)==null||t.style.setProperty(`left`,`${n}%`)}updateSegments(e){let t=this.shadowRoot.querySelector(`#segments-clipping`);if(t.textContent=``,this.container.classList.toggle(`segments`,!!e?.length),!e?.length)return;let n=[...new Set([+this.range.min,...e.flatMap(e=>[e.start,e.end]),+this.range.max])];jf(this,Rf,[...n]);let r=n.pop();for(let[e,i]of n.entries()){let[a,o]=[e===0,e===n.length-1],s=a?`calc(var(--segments-gap) / -1)`:`${i*100}%`,c=`calc(${((o?r:n[e+1])-i)*100}%${a||o?``:` - var(--segments-gap)`})`,l=sc.createElementNS(`http://www.w3.org/2000/svg`,`rect`),u=Dc(this.shadowRoot,`#segments-clipping rect:nth-child(${e+1})`);u.style.setProperty(`x`,s),u.style.setProperty(`width`,c),t.append(l)}}getPointerRatio(e){return wc(e.clientX,e.clientY,W(this,Ff).getBoundingClientRect(),W(this,If).getBoundingClientRect())}get dragging(){return this.hasAttribute(`dragging`)}handleEvent(e){switch(e.type){case`pointermove`:Mf(this,np,rp).call(this,e);break;case`input`:this.updateBar();break;case`pointerenter`:Mf(this,Xf,Zf).call(this,e);break;case`pointerdown`:Mf(this,Jf,Yf).call(this,e);break;case`pointerup`:Mf(this,Qf,$f).call(this);break;case`pointerleave`:Mf(this,ep,tp).call(this)}}get keysUsed(){return[`ArrowUp`,`ArrowRight`,`ArrowDown`,`ArrowLeft`]}};Nf=new WeakMap,Pf=new WeakMap,Ff=new WeakMap,If=new WeakMap,Lf=new WeakMap,Rf=new WeakMap,zf=new WeakMap,Bf=new WeakMap,Vf=new WeakMap,Hf=new WeakSet,Uf=function(e){let t=W(this,Lf).activeSegment;if(!t)return;let n=this.getPointerRatio(e),r=`#segments-clipping rect:nth-child(${W(this,Rf).findIndex((e,t,r)=>{let i=r[t+1];return i!=null&&n>=e&&n<=i})+1})`;t.selectorText==r&&t.style.transform||(t.selectorText=r,t.style.setProperty(`transform`,`var(--media-range-segment-hover-transform, scaleY(2))`))},Wf=new WeakSet,Gf=function(){!this.hasAttribute(`disabled`)&&this.isConnected&&(this.addEventListener(`input`,this),this.addEventListener(`pointerdown`,this),this.addEventListener(`pointerenter`,this))},Kf=new WeakSet,qf=function(){var e,t;this.removeEventListener(`input`,this),this.removeEventListener(`pointerdown`,this),this.removeEventListener(`pointerenter`,this),this.removeEventListener(`pointerleave`,this),(e=N.window)==null||e.removeEventListener(`pointerup`,this),(t=N.window)==null||t.removeEventListener(`pointermove`,this)},Jf=new WeakSet,Yf=function(e){var t;jf(this,Pf,e.composedPath().includes(this.range)),(t=N.window)==null||t.addEventListener(`pointerup`,this,{once:!0})},Xf=new WeakSet,Zf=function(e){var t;e.pointerType!==`mouse`&&Mf(this,Jf,Yf).call(this,e),this.addEventListener(`pointerleave`,this,{once:!0}),(t=N.window)==null||t.addEventListener(`pointermove`,this)},Qf=new WeakSet,$f=function(){var e;(e=N.window)==null||e.removeEventListener(`pointerup`,this),this.toggleAttribute(`dragging`,!1),this.range.disabled=this.hasAttribute(`disabled`)},ep=new WeakSet,tp=function(){var e,t;this.removeEventListener(`pointerleave`,this),(e=N.window)==null||e.removeEventListener(`pointermove`,this),this.toggleAttribute(`dragging`,!1),this.range.disabled=this.hasAttribute(`disabled`),(t=W(this,Lf).activeSegment)==null||t.style.removeProperty(`transform`)},np=new WeakSet,rp=function(e){(e.pointerType!==`pen`||e.buttons!==0)&&(this.toggleAttribute(`dragging`,e.buttons===1||e.pointerType!==`mouse`),this.updatePointerBar(e),Mf(this,Hf,Uf).call(this,e),this.dragging&&(e.pointerType!==`mouse`||!W(this,Pf))&&(this.range.disabled=!0,this.range.valueAsNumber=this.getPointerRatio(e),this.range.dispatchEvent(new Event(`input`,{bubbles:!0,composed:!0}))))},op.shadowRootOptions={mode:`open`},op.getTemplateHTML=ip,op.getContainerTemplateHTML=ap,N.customElements.get(`media-chrome-range`)||N.customElements.define(`media-chrome-range`,op);var sp=(e,t,n)=>{if(!t.has(e))throw TypeError(`Cannot `+n)},cp=(e,t,n)=>(sp(e,t,`read from private field`),n?n.call(e):t.get(e)),lp=(e,t,n)=>{if(t.has(e))throw TypeError(`Cannot add the same private member more than once`);t instanceof WeakSet?t.add(e):t.set(e,n)},up=(e,t,n,r)=>(sp(e,t,`write to private field`),r?r.call(e,n):t.set(e,n),n),dp;function fp(e){return`
    <style>
      :host {
        
        box-sizing: border-box;
        display: var(--media-control-display, var(--media-control-bar-display, inline-flex));
        color: var(--media-text-color, var(--media-primary-color, rgb(238 238 238)));
        --media-loading-indicator-icon-height: 44px;
      }

      ::slotted(media-time-range),
      ::slotted(media-volume-range) {
        min-height: 100%;
      }

      ::slotted(media-time-range),
      ::slotted(media-clip-selector) {
        flex-grow: 1;
      }

      ::slotted([role="menu"]) {
        position: absolute;
      }
    </style>

    <slot></slot>
  `}var pp=class extends N.HTMLElement{constructor(){if(super(),lp(this,dp,void 0),!this.shadowRoot){this.attachShadow(this.constructor.shadowRootOptions);let e=pc(this.attributes);this.shadowRoot.innerHTML=this.constructor.getTemplateHTML(e)}}static get observedAttributes(){return[A.MEDIA_CONTROLLER]}attributeChangedCallback(e,t,n){var r,i,a,o;e===A.MEDIA_CONTROLLER&&(t&&((i=(r=cp(this,dp))?.unassociateElement)==null||i.call(r,this),up(this,dp,null)),n&&this.isConnected&&(up(this,dp,this.getRootNode()?.getElementById(n)),(o=(a=cp(this,dp))?.associateElement)==null||o.call(a,this)))}connectedCallback(){var e,t;let n=this.getAttribute(A.MEDIA_CONTROLLER);n&&(up(this,dp,this.getRootNode()?.getElementById(n)),(t=(e=cp(this,dp))?.associateElement)==null||t.call(e,this))}disconnectedCallback(){var e,t;(t=(e=cp(this,dp))?.unassociateElement)==null||t.call(e,this),up(this,dp,null)}};dp=new WeakMap,pp.shadowRootOptions={mode:`open`},pp.getTemplateHTML=fp,N.customElements.get(`media-control-bar`)||N.customElements.define(`media-control-bar`,pp);var mp=(e,t,n)=>{if(!t.has(e))throw TypeError(`Cannot `+n)},hp=(e,t,n)=>(mp(e,t,`read from private field`),n?n.call(e):t.get(e)),gp=(e,t,n)=>{if(t.has(e))throw TypeError(`Cannot add the same private member more than once`);t instanceof WeakSet?t.add(e):t.set(e,n)},_p=(e,t,n,r)=>(mp(e,t,`write to private field`),r?r.call(e,n):t.set(e,n),n),vp;function yp(e,t={}){return`
    <style>
      :host {
        font: var(--media-font,
          var(--media-font-weight, normal)
          var(--media-font-size, 14px) /
          var(--media-text-content-height, var(--media-control-height, 24px))
          var(--media-font-family, helvetica neue, segoe ui, roboto, arial, sans-serif));
        color: var(--media-text-color, var(--media-primary-color, rgb(238 238 238)));
        background: var(--media-text-background, var(--media-control-background, var(--media-secondary-color, rgb(20 20 30 / .7))));
        padding: var(--media-control-padding, 10px);
        display: inline-flex;
        justify-content: center;
        align-items: center;
        vertical-align: middle;
        box-sizing: border-box;
        text-align: center;
        pointer-events: auto;
      }

      
      :host(:focus-visible) {
        box-shadow: var(--media-focus-box-shadow, inset 0 0 0 2px rgb(27 127 204 / .9));
        outline: 0;
      }

      
      :host(:where(:focus)) {
        box-shadow: none;
        outline: 0;
      }
    </style>

    ${this.getSlotTemplateHTML(e,t)}
  `}function bp(e,t){return`
    <slot></slot>
  `}var xp=class extends N.HTMLElement{constructor(){if(super(),gp(this,vp,void 0),!this.shadowRoot){this.attachShadow(this.constructor.shadowRootOptions);let e=pc(this.attributes);this.shadowRoot.innerHTML=this.constructor.getTemplateHTML(e)}}static get observedAttributes(){return[A.MEDIA_CONTROLLER]}attributeChangedCallback(e,t,n){var r,i,a,o;e===A.MEDIA_CONTROLLER&&(t&&((i=(r=hp(this,vp))?.unassociateElement)==null||i.call(r,this),_p(this,vp,null)),n&&this.isConnected&&(_p(this,vp,this.getRootNode()?.getElementById(n)),(o=(a=hp(this,vp))?.associateElement)==null||o.call(a,this)))}connectedCallback(){var e,t;let{style:n}=Tc(this.shadowRoot,`:host`);n.setProperty(`display`,`var(--media-control-display, var(--${this.localName}-display, inline-flex))`);let r=this.getAttribute(A.MEDIA_CONTROLLER);r&&(_p(this,vp,this.getRootNode()?.getElementById(r)),(t=(e=hp(this,vp))?.associateElement)==null||t.call(e,this))}disconnectedCallback(){var e,t;(t=(e=hp(this,vp))?.unassociateElement)==null||t.call(e,this),_p(this,vp,null)}};vp=new WeakMap,xp.shadowRootOptions={mode:`open`},xp.getTemplateHTML=yp,xp.getSlotTemplateHTML=bp,N.customElements.get(`media-text-display`)||N.customElements.define(`media-text-display`,xp);var Sp=(e,t,n)=>{if(!t.has(e))throw TypeError(`Cannot `+n)},Cp=(e,t,n)=>(Sp(e,t,`read from private field`),n?n.call(e):t.get(e)),wp=(e,t,n)=>{if(t.has(e))throw TypeError(`Cannot add the same private member more than once`);t instanceof WeakSet?t.add(e):t.set(e,n)},Tp=(e,t,n,r)=>(Sp(e,t,`write to private field`),r?r.call(e,n):t.set(e,n),n),Ep;function Dp(e,t){return`
    <slot>${Qs(t.mediaDuration)}</slot>
  `}var Op=class extends xp{constructor(){super(),wp(this,Ep,void 0),Tp(this,Ep,this.shadowRoot.querySelector(`slot`)),Cp(this,Ep).textContent=Qs(this.mediaDuration??0)}static get observedAttributes(){return[...super.observedAttributes,j.MEDIA_DURATION]}attributeChangedCallback(e,t,n){e===j.MEDIA_DURATION&&(Cp(this,Ep).textContent=Qs(+n)),super.attributeChangedCallback(e,t,n)}get mediaDuration(){return P(this,j.MEDIA_DURATION)}set mediaDuration(e){F(this,j.MEDIA_DURATION,e)}};Ep=new WeakMap,Op.getSlotTemplateHTML=Dp,N.customElements.get(`media-duration-display`)||N.customElements.define(`media-duration-display`,Op);var kp={2:M(`Network Error`),3:M(`Decode Error`),4:M(`Source Not Supported`),5:M(`Encryption Error`)},Ap={2:M(`A network error caused the media download to fail.`),3:M(`A media error caused playback to be aborted. The media could be corrupt or your browser does not support this format.`),4:M(`An unsupported error occurred. The server or network failed, or your browser does not support this format.`),5:M(`The media is encrypted and there are no keys to decrypt it.`)},jp=e=>e.code===1?null:{title:kp[e.code]??`Error ${e.code}`,message:Ap[e.code]??e.message},Mp=(e,t,n)=>{if(!t.has(e))throw TypeError(`Cannot `+n)},Np=(e,t,n)=>(Mp(e,t,`read from private field`),n?n.call(e):t.get(e)),Pp=(e,t,n)=>{if(t.has(e))throw TypeError(`Cannot add the same private member more than once`);t instanceof WeakSet?t.add(e):t.set(e,n)},Fp=(e,t,n,r)=>(Mp(e,t,`write to private field`),r?r.call(e,n):t.set(e,n),n),Ip;function Lp(e){let t=+e.mediaerrorcode;return`
    <style>
      :host {
        background: rgb(20 20 30 / .8);
      }

      #content {
        display: block;
        padding: 1.2em 1.5em;
      }

      h3,
      p {
        margin-block: 0 .3em;
      }
    </style>
    <slot name="error-${t}" id="content">
      ${zp({code:t,message:e.mediaerrormessage})}
    </slot>
  `}function Rp(e){return e.code&&jp(e)!==null}function zp(e){let{title:t,message:n}=jp(e)??{},r=Us(e.code),i=``;return t&&(i+=`<slot name="error-${r}-title"><h3>${Us(t)}</h3></slot>`),n&&(i+=`<slot name="error-${r}-message"><p>${Us(n)}</p></slot>`),i}var Bp=[j.MEDIA_ERROR_CODE,j.MEDIA_ERROR_MESSAGE],Vp=class extends zl{constructor(){super(...arguments),Pp(this,Ip,null)}static get observedAttributes(){return[...super.observedAttributes,...Bp]}formatErrorMessage(e){return this.constructor.formatErrorMessage(e)}attributeChangedCallback(e,t,n){if(super.attributeChangedCallback(e,t,n),!Bp.includes(e))return;let r=this.mediaError??{code:this.mediaErrorCode,message:this.mediaErrorMessage};if(this.open=Rp(r),this.open&&(this.shadowRoot.querySelector(`slot`).name=`error-${this.mediaErrorCode}`,this.shadowRoot.querySelector(`#content`).innerHTML=this.formatErrorMessage(r),!this.hasAttribute(`aria-label`))){let{title:e}=jp(r);e&&this.setAttribute(`aria-label`,e)}}get mediaError(){return Np(this,Ip)}set mediaError(e){Fp(this,Ip,e)}get mediaErrorCode(){return P(this,`mediaerrorcode`)}set mediaErrorCode(e){F(this,`mediaerrorcode`,e)}get mediaErrorMessage(){return R(this,`mediaerrormessage`)}set mediaErrorMessage(e){z(this,`mediaerrormessage`,e)}};Ip=new WeakMap,Vp.getSlotTemplateHTML=Lp,Vp.formatErrorMessage=zp,N.customElements.get(`media-error-dialog`)||N.customElements.define(`media-error-dialog`,Vp);var Hp=Vp,Up=(e,t,n)=>{if(!t.has(e))throw TypeError(`Cannot `+n)},Wp=(e,t,n)=>(Up(e,t,`read from private field`),n?n.call(e):t.get(e)),Gp=(e,t,n)=>{if(t.has(e))throw TypeError(`Cannot add the same private member more than once`);t instanceof WeakSet?t.add(e):t.set(e,n)},Kp=(e,t,n,r)=>(Up(e,t,`write to private field`),r?r.call(e,n):t.set(e,n),n),qp,Jp=`<svg aria-hidden="true" viewBox="0 0 26 24">
  <path d="M16 3v2.5h3.5V9H22V3h-6ZM4 9h2.5V5.5H10V3H4v6Zm15.5 9.5H16V21h6v-6h-2.5v3.5ZM6.5 15H4v6h6v-2.5H6.5V15Z"/>
</svg>`,Yp=`<svg aria-hidden="true" viewBox="0 0 26 24">
  <path d="M18.5 6.5V3H16v6h6V6.5h-3.5ZM16 21h2.5v-3.5H22V15h-6v6ZM4 17.5h3.5V21H10v-6H4v2.5Zm3.5-11H4V9h6V3H7.5v3.5Z"/>
</svg>`;function Xp(e){return`
    <style>
      :host([${j.MEDIA_IS_FULLSCREEN}]) slot[name=icon] slot:not([name=exit]) {
        display: none !important;
      }

      
      :host(:not([${j.MEDIA_IS_FULLSCREEN}])) slot[name=icon] slot:not([name=enter]) {
        display: none !important;
      }

      :host([${j.MEDIA_IS_FULLSCREEN}]) slot[name=tooltip-enter],
      :host(:not([${j.MEDIA_IS_FULLSCREEN}])) slot[name=tooltip-exit] {
        display: none;
      }
    </style>

    <slot name="icon">
      <slot name="enter">${Jp}</slot>
      <slot name="exit">${Yp}</slot>
    </slot>
  `}function Zp(){return`
    <slot name="tooltip-enter">${M(`Enter fullscreen mode`)}</slot>
    <slot name="tooltip-exit">${M(`Exit fullscreen mode`)}</slot>
  `}var Qp=e=>{let t=e.mediaIsFullscreen?M(`exit fullscreen mode`):M(`enter fullscreen mode`);e.setAttribute(`aria-label`,t)},$p=class extends lf{constructor(){super(...arguments),Gp(this,qp,null)}static get observedAttributes(){return[...super.observedAttributes,j.MEDIA_IS_FULLSCREEN,j.MEDIA_FULLSCREEN_UNAVAILABLE]}connectedCallback(){super.connectedCallback(),Qp(this)}attributeChangedCallback(e,t,n){super.attributeChangedCallback(e,t,n),e===j.MEDIA_IS_FULLSCREEN&&Qp(this)}get mediaFullscreenUnavailable(){return R(this,j.MEDIA_FULLSCREEN_UNAVAILABLE)}set mediaFullscreenUnavailable(e){z(this,j.MEDIA_FULLSCREEN_UNAVAILABLE,e)}get mediaIsFullscreen(){return I(this,j.MEDIA_IS_FULLSCREEN)}set mediaIsFullscreen(e){L(this,j.MEDIA_IS_FULLSCREEN,e)}handleClick(e){Kp(this,qp,e);let t=Wp(this,qp)instanceof PointerEvent,n=this.mediaIsFullscreen?new N.CustomEvent(k.MEDIA_EXIT_FULLSCREEN_REQUEST,{composed:!0,bubbles:!0}):new N.CustomEvent(k.MEDIA_ENTER_FULLSCREEN_REQUEST,{composed:!0,bubbles:!0,detail:t});this.dispatchEvent(n)}};qp=new WeakMap,$p.getSlotTemplateHTML=Xp,$p.getTooltipContentHTML=Zp,N.customElements.get(`media-fullscreen-button`)||N.customElements.define(`media-fullscreen-button`,$p);var{MEDIA_TIME_IS_LIVE:em,MEDIA_PAUSED:tm}=j,{MEDIA_SEEK_TO_LIVE_REQUEST:nm,MEDIA_PLAY_REQUEST:rm}=k,im=`<svg viewBox="0 0 6 12" aria-hidden="true"><circle cx="3" cy="6" r="2"></circle></svg>`;function am(e){return`
    <style>
      :host { --media-tooltip-display: none; }
      
      slot[name=indicator] > *,
      :host ::slotted([slot=indicator]) {
        
        min-width: auto;
        fill: var(--media-live-button-icon-color, rgb(140, 140, 140));
        color: var(--media-live-button-icon-color, rgb(140, 140, 140));
      }

      :host([${em}]:not([${tm}])) slot[name=indicator] > *,
      :host([${em}]:not([${tm}])) ::slotted([slot=indicator]) {
        fill: var(--media-live-button-indicator-color, rgb(255, 0, 0));
        color: var(--media-live-button-indicator-color, rgb(255, 0, 0));
      }

      :host([${em}]:not([${tm}])) {
        cursor: var(--media-cursor, not-allowed);
      }

      slot[name=text]{
        text-transform: uppercase;
      }

    </style>

    <slot name="indicator">${im}</slot>
    
    <slot name="spacer">&nbsp;</slot><slot name="text">${M(`live`)}</slot>
  `}var om=e=>{let t=e.mediaPaused||!e.mediaTimeIsLive,n=M(t?`seek to live`:`playing live`);e.setAttribute(`aria-label`,n);let r=e.shadowRoot?.querySelector(`slot[name="text"]`);r&&(r.textContent=M(`live`)),t?e.removeAttribute(`aria-disabled`):e.setAttribute(`aria-disabled`,`true`)},sm=class extends lf{static get observedAttributes(){return[...super.observedAttributes,em,tm]}connectedCallback(){super.connectedCallback(),om(this)}attributeChangedCallback(e,t,n){super.attributeChangedCallback(e,t,n),om(this)}get mediaPaused(){return I(this,j.MEDIA_PAUSED)}set mediaPaused(e){L(this,j.MEDIA_PAUSED,e)}get mediaTimeIsLive(){return I(this,j.MEDIA_TIME_IS_LIVE)}set mediaTimeIsLive(e){L(this,j.MEDIA_TIME_IS_LIVE,e)}handleClick(){(this.mediaPaused||!this.mediaTimeIsLive)&&(this.dispatchEvent(new N.CustomEvent(nm,{composed:!0,bubbles:!0})),this.hasAttribute(tm)&&this.dispatchEvent(new N.CustomEvent(rm,{composed:!0,bubbles:!0})))}};sm.getSlotTemplateHTML=am,N.customElements.get(`media-live-button`)||N.customElements.define(`media-live-button`,sm);var cm=(e,t,n)=>{if(!t.has(e))throw TypeError(`Cannot `+n)},lm=(e,t,n)=>(cm(e,t,`read from private field`),n?n.call(e):t.get(e)),um=(e,t,n)=>{if(t.has(e))throw TypeError(`Cannot add the same private member more than once`);t instanceof WeakSet?t.add(e):t.set(e,n)},dm=(e,t,n,r)=>(cm(e,t,`write to private field`),r?r.call(e,n):t.set(e,n),n),fm,pm,mm={LOADING_DELAY:`loadingdelay`,NO_AUTOHIDE:`noautohide`},hm=500,gm=`
<svg aria-hidden="true" viewBox="0 0 100 100">
  <path d="M73,50c0-12.7-10.3-23-23-23S27,37.3,27,50 M30.9,50c0-10.5,8.5-19.1,19.1-19.1S69.1,39.5,69.1,50">
    <animateTransform
       attributeName="transform"
       attributeType="XML"
       type="rotate"
       dur="1s"
       from="0 50 50"
       to="360 50 50"
       repeatCount="indefinite" />
  </path>
</svg>
`;function _m(e){return`
    <style>
      :host {
        display: var(--media-control-display, var(--media-loading-indicator-display, inline-block));
        vertical-align: middle;
        box-sizing: border-box;
        --_loading-indicator-delay: var(--media-loading-indicator-transition-delay, ${hm}ms);
      }

      #status {
        color: rgba(0,0,0,0);
        width: 0px;
        height: 0px;
      }

      :host slot[name=icon] > *,
      :host ::slotted([slot=icon]) {
        opacity: var(--media-loading-indicator-opacity, 0);
        transition: opacity 0.15s;
      }

      :host([${j.MEDIA_LOADING}]:not([${j.MEDIA_PAUSED}])) slot[name=icon] > *,
      :host([${j.MEDIA_LOADING}]:not([${j.MEDIA_PAUSED}])) ::slotted([slot=icon]) {
        opacity: var(--media-loading-indicator-opacity, 1);
        transition: opacity 0.15s var(--_loading-indicator-delay);
      }

      :host #status {
        visibility: var(--media-loading-indicator-opacity, hidden);
        transition: visibility 0.15s;
      }

      :host([${j.MEDIA_LOADING}]:not([${j.MEDIA_PAUSED}])) #status {
        visibility: var(--media-loading-indicator-opacity, visible);
        transition: visibility 0.15s var(--_loading-indicator-delay);
      }

      svg, img, ::slotted(svg), ::slotted(img) {
        width: var(--media-loading-indicator-icon-width);
        height: var(--media-loading-indicator-icon-height, 100px);
        fill: var(--media-icon-color, var(--media-primary-color, rgb(238 238 238)));
        vertical-align: middle;
      }
    </style>

    <slot name="icon">${gm}</slot>
    <div id="status" role="status" aria-live="polite">${M(`media loading`)}</div>
  `}var vm=class extends N.HTMLElement{constructor(){if(super(),um(this,fm,void 0),um(this,pm,hm),!this.shadowRoot){this.attachShadow(this.constructor.shadowRootOptions);let e=pc(this.attributes);this.shadowRoot.innerHTML=this.constructor.getTemplateHTML(e)}}static get observedAttributes(){return[A.MEDIA_CONTROLLER,j.MEDIA_PAUSED,j.MEDIA_LOADING,mm.LOADING_DELAY]}attributeChangedCallback(e,t,n){var r,i,a,o;e===mm.LOADING_DELAY&&t!==n?this.loadingDelay=Number(n):e===A.MEDIA_CONTROLLER&&(t&&((i=(r=lm(this,fm))?.unassociateElement)==null||i.call(r,this),dm(this,fm,null)),n&&this.isConnected&&(dm(this,fm,this.getRootNode()?.getElementById(n)),(o=(a=lm(this,fm))?.associateElement)==null||o.call(a,this)))}connectedCallback(){var e,t;let n=this.getAttribute(A.MEDIA_CONTROLLER);n&&(dm(this,fm,this.getRootNode()?.getElementById(n)),(t=(e=lm(this,fm))?.associateElement)==null||t.call(e,this))}disconnectedCallback(){var e,t;(t=(e=lm(this,fm))?.unassociateElement)==null||t.call(e,this),dm(this,fm,null)}get loadingDelay(){return lm(this,pm)}set loadingDelay(e){dm(this,pm,e);let{style:t}=Tc(this.shadowRoot,`:host`);t.setProperty(`--_loading-indicator-delay`,`var(--media-loading-indicator-transition-delay, ${e}ms)`)}get mediaPaused(){return I(this,j.MEDIA_PAUSED)}set mediaPaused(e){L(this,j.MEDIA_PAUSED,e)}get mediaLoading(){return I(this,j.MEDIA_LOADING)}set mediaLoading(e){L(this,j.MEDIA_LOADING,e)}get mediaController(){return R(this,A.MEDIA_CONTROLLER)}set mediaController(e){z(this,A.MEDIA_CONTROLLER,e)}get noAutohide(){return I(this,mm.NO_AUTOHIDE)}set noAutohide(e){L(this,mm.NO_AUTOHIDE,e)}};fm=new WeakMap,pm=new WeakMap,vm.shadowRootOptions={mode:`open`},vm.getTemplateHTML=_m,N.customElements.get(`media-loading-indicator`)||N.customElements.define(`media-loading-indicator`,vm);var ym=`<svg aria-hidden="true" viewBox="0 0 24 24">
  <path d="M16.5 12A4.5 4.5 0 0 0 14 8v2.18l2.45 2.45a4.22 4.22 0 0 0 .05-.63Zm2.5 0a6.84 6.84 0 0 1-.54 2.64L20 16.15A8.8 8.8 0 0 0 21 12a9 9 0 0 0-7-8.77v2.06A7 7 0 0 1 19 12ZM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25A6.92 6.92 0 0 1 14 18.7v2.06A9 9 0 0 0 17.69 19l2 2.05L21 19.73l-9-9L4.27 3ZM12 4 9.91 6.09 12 8.18V4Z"/>
</svg>`,bm=`<svg aria-hidden="true" viewBox="0 0 24 24">
  <path d="M3 9v6h4l5 5V4L7 9H3Zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.47 4.47 0 0 0 2.5-4Z"/>
</svg>`,xm=`<svg aria-hidden="true" viewBox="0 0 24 24">
  <path d="M3 9v6h4l5 5V4L7 9H3Zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.47 4.47 0 0 0 2.5-4ZM14 3.23v2.06a7 7 0 0 1 0 13.42v2.06a9 9 0 0 0 0-17.54Z"/>
</svg>`;function Sm(e){return`
    <style>
      :host(:not([${j.MEDIA_VOLUME_LEVEL}])) slot[name=icon] slot:not([name=high]),
      :host([${j.MEDIA_VOLUME_LEVEL}=high]) slot[name=icon] slot:not([name=high]) {
        display: none !important;
      }

      :host([${j.MEDIA_VOLUME_LEVEL}=off]) slot[name=icon] slot:not([name=off]) {
        display: none !important;
      }

      :host([${j.MEDIA_VOLUME_LEVEL}=low]) slot[name=icon] slot:not([name=low]) {
        display: none !important;
      }

      :host([${j.MEDIA_VOLUME_LEVEL}=medium]) slot[name=icon] slot:not([name=medium]) {
        display: none !important;
      }

      :host(:not([${j.MEDIA_VOLUME_LEVEL}=off])) slot[name=tooltip-unmute],
      :host([${j.MEDIA_VOLUME_LEVEL}=off]) slot[name=tooltip-mute] {
        display: none;
      }
    </style>

    <slot name="icon">
      <slot name="off">${ym}</slot>
      <slot name="low">${bm}</slot>
      <slot name="medium">${bm}</slot>
      <slot name="high">${xm}</slot>
    </slot>
  `}function Cm(){return`
    <slot name="tooltip-mute">${M(`Mute`)}</slot>
    <slot name="tooltip-unmute">${M(`Unmute`)}</slot>
  `}var wm=e=>{let t=e.mediaVolumeLevel===`off`?M(`unmute`):M(`mute`);e.setAttribute(`aria-label`,t)},Tm=class extends lf{static get observedAttributes(){return[...super.observedAttributes,j.MEDIA_VOLUME_LEVEL]}connectedCallback(){super.connectedCallback(),wm(this)}attributeChangedCallback(e,t,n){super.attributeChangedCallback(e,t,n),e===j.MEDIA_VOLUME_LEVEL&&wm(this)}get mediaVolumeLevel(){return R(this,j.MEDIA_VOLUME_LEVEL)}set mediaVolumeLevel(e){z(this,j.MEDIA_VOLUME_LEVEL,e)}handleClick(){let e=this.mediaVolumeLevel===`off`?k.MEDIA_UNMUTE_REQUEST:k.MEDIA_MUTE_REQUEST;this.dispatchEvent(new N.CustomEvent(e,{composed:!0,bubbles:!0}))}};Tm.getSlotTemplateHTML=Sm,Tm.getTooltipContentHTML=Cm,N.customElements.get(`media-mute-button`)||N.customElements.define(`media-mute-button`,Tm);var Em=`<svg aria-hidden="true" viewBox="0 0 28 24">
  <path d="M24 3H4a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h20a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1Zm-1 16H5V5h18v14Zm-3-8h-7v5h7v-5Z"/>
</svg>`;function Dm(e){return`
    <style>
      :host([${j.MEDIA_IS_PIP}]) slot[name=icon] slot:not([name=exit]) {
        display: none !important;
      }

      :host(:not([${j.MEDIA_IS_PIP}])) slot[name=icon] slot:not([name=enter]) {
        display: none !important;
      }

      :host([${j.MEDIA_IS_PIP}]) slot[name=tooltip-enter],
      :host(:not([${j.MEDIA_IS_PIP}])) slot[name=tooltip-exit] {
        display: none;
      }
    </style>

    <slot name="icon">
      <slot name="enter">${Em}</slot>
      <slot name="exit">${Em}</slot>
    </slot>
  `}function Om(){return`
    <slot name="tooltip-enter">${M(`Enter picture in picture mode`)}</slot>
    <slot name="tooltip-exit">${M(`Exit picture in picture mode`)}</slot>
  `}var km=e=>{let t=e.mediaIsPip?M(`exit picture in picture mode`):M(`enter picture in picture mode`);e.setAttribute(`aria-label`,t)},Am=class extends lf{static get observedAttributes(){return[...super.observedAttributes,j.MEDIA_IS_PIP,j.MEDIA_PIP_UNAVAILABLE]}connectedCallback(){super.connectedCallback(),km(this)}attributeChangedCallback(e,t,n){super.attributeChangedCallback(e,t,n),e===j.MEDIA_IS_PIP&&km(this)}get mediaPipUnavailable(){return R(this,j.MEDIA_PIP_UNAVAILABLE)}set mediaPipUnavailable(e){z(this,j.MEDIA_PIP_UNAVAILABLE,e)}get mediaIsPip(){return I(this,j.MEDIA_IS_PIP)}set mediaIsPip(e){L(this,j.MEDIA_IS_PIP,e)}handleClick(){let e=this.mediaIsPip?k.MEDIA_EXIT_PIP_REQUEST:k.MEDIA_ENTER_PIP_REQUEST;this.dispatchEvent(new N.CustomEvent(e,{composed:!0,bubbles:!0}))}};Am.getSlotTemplateHTML=Dm,Am.getTooltipContentHTML=Om,N.customElements.get(`media-pip-button`)||N.customElements.define(`media-pip-button`,Am);var jm=(e,t,n)=>{if(!t.has(e))throw TypeError(`Cannot `+n)},Mm=(e,t,n)=>(jm(e,t,`read from private field`),n?n.call(e):t.get(e)),Nm=(e,t,n)=>{if(t.has(e))throw TypeError(`Cannot add the same private member more than once`);t instanceof WeakSet?t.add(e):t.set(e,n)},Pm,Fm={RATES:`rates`},Im=[1,1.2,1.5,1.7,2];function Lm(e){return Math.round(e*100)/100}function Rm(e){return`
    <style>
      :host {
        min-width: 5ch;
        padding: var(--media-button-padding, var(--media-control-padding, 10px 5px));
      }
    </style>
    <slot name="icon">${e.mediaplaybackrate?Lm(+e.mediaplaybackrate):1}x</slot>
  `}function zm(){return M(`Playback rate`)}var Bm=class extends lf{constructor(){super(),Nm(this,Pm,new cu(this,Fm.RATES,{defaultValue:Im})),this.container=this.shadowRoot.querySelector(`slot[name="icon"]`),this.container.innerHTML=`${Lm(this.mediaPlaybackRate??1)}x`}static get observedAttributes(){return[...super.observedAttributes,j.MEDIA_PLAYBACK_RATE,Fm.RATES]}attributeChangedCallback(e,t,n){if(super.attributeChangedCallback(e,t,n),e===Fm.RATES&&(Mm(this,Pm).value=n),e===j.MEDIA_PLAYBACK_RATE){let e=n?+n:NaN,t=Lm(Number.isNaN(e)?1:e);this.container.innerHTML=`${t}x`,this.setAttribute(`aria-label`,M(`Playback rate {playbackRate}`,{playbackRate:t}))}}get rates(){return Mm(this,Pm)}set rates(e){e?Array.isArray(e)?Mm(this,Pm).value=e.join(` `):typeof e==`string`&&(Mm(this,Pm).value=e):Mm(this,Pm).value=``}get mediaPlaybackRate(){return P(this,j.MEDIA_PLAYBACK_RATE,1)}set mediaPlaybackRate(e){F(this,j.MEDIA_PLAYBACK_RATE,e)}handleClick(){let e=Array.from(Mm(this,Pm).values(),e=>+e).sort((e,t)=>e-t),t=e.find(e=>e>this.mediaPlaybackRate)??e[0]??1,n=new N.CustomEvent(k.MEDIA_PLAYBACK_RATE_REQUEST,{composed:!0,bubbles:!0,detail:t});this.dispatchEvent(n)}};Pm=new WeakMap,Bm.getSlotTemplateHTML=Rm,Bm.getTooltipContentHTML=zm,N.customElements.get(`media-playback-rate-button`)||N.customElements.define(`media-playback-rate-button`,Bm);var Vm=`<svg aria-hidden="true" viewBox="0 0 24 24">
  <path d="m6 21 15-9L6 3v18Z"/>
</svg>`,Hm=`<svg aria-hidden="true" viewBox="0 0 24 24">
  <path d="M6 20h4V4H6v16Zm8-16v16h4V4h-4Z"/>
</svg>`;function Um(e){return`
    <style>
      :host([${j.MEDIA_PAUSED}]) slot[name=pause],
      :host(:not([${j.MEDIA_PAUSED}])) slot[name=play] {
        display: none !important;
      }

      :host([${j.MEDIA_PAUSED}]) slot[name=tooltip-pause],
      :host(:not([${j.MEDIA_PAUSED}])) slot[name=tooltip-play] {
        display: none;
      }
    </style>

    <slot name="icon">
      <slot name="play">${Vm}</slot>
      <slot name="pause">${Hm}</slot>
    </slot>
  `}function Wm(){return`
    <slot name="tooltip-play">${M(`Play`)}</slot>
    <slot name="tooltip-pause">${M(`Pause`)}</slot>
  `}var Gm=e=>{let t=e.mediaPaused?M(`play`):M(`pause`);e.setAttribute(`aria-label`,t)},Km=class extends lf{static get observedAttributes(){return[...super.observedAttributes,j.MEDIA_PAUSED,j.MEDIA_ENDED]}connectedCallback(){super.connectedCallback(),Gm(this)}attributeChangedCallback(e,t,n){super.attributeChangedCallback(e,t,n),(e===j.MEDIA_PAUSED||e===j.MEDIA_LANG)&&Gm(this)}get mediaPaused(){return I(this,j.MEDIA_PAUSED)}set mediaPaused(e){L(this,j.MEDIA_PAUSED,e)}handleClick(){let e=this.mediaPaused?k.MEDIA_PLAY_REQUEST:k.MEDIA_PAUSE_REQUEST;this.dispatchEvent(new N.CustomEvent(e,{composed:!0,bubbles:!0}))}};Km.getSlotTemplateHTML=Um,Km.getTooltipContentHTML=Wm,N.customElements.get(`media-play-button`)||N.customElements.define(`media-play-button`,Km);var qm={PLACEHOLDER_SRC:`placeholdersrc`,SRC:`src`};function Jm(e){return`
    <style>
      :host {
        pointer-events: none;
        display: var(--media-poster-image-display, inline-block);
        box-sizing: border-box;
      }

      img {
        max-width: 100%;
        max-height: 100%;
        min-width: 100%;
        min-height: 100%;
        background-repeat: no-repeat;
        background-position: var(--media-poster-image-background-position, var(--media-object-position, center));
        background-size: var(--media-poster-image-background-size, var(--media-object-fit, contain));
        object-fit: var(--media-object-fit, contain);
        object-position: var(--media-object-position, center);
      }
    </style>

    <img part="poster img" aria-hidden="true" id="image"/>
  `}var Ym=e=>{e.style.removeProperty(`background-image`)},Xm=(e,t)=>{e.style[`background-image`]=`url('${t}')`},Zm=class extends N.HTMLElement{static get observedAttributes(){return[qm.PLACEHOLDER_SRC,qm.SRC]}constructor(){if(super(),!this.shadowRoot){this.attachShadow(this.constructor.shadowRootOptions);let e=pc(this.attributes);this.shadowRoot.innerHTML=this.constructor.getTemplateHTML(e)}this.image=this.shadowRoot.querySelector(`#image`)}attributeChangedCallback(e,t,n){e===qm.SRC&&(n==null?this.image.removeAttribute(qm.SRC):this.image.setAttribute(qm.SRC,n)),e===qm.PLACEHOLDER_SRC&&(n==null?Ym(this.image):Xm(this.image,n))}get placeholderSrc(){return R(this,qm.PLACEHOLDER_SRC)}set placeholderSrc(e){z(this,qm.SRC,e)}get src(){return R(this,qm.SRC)}set src(e){z(this,qm.SRC,e)}};Zm.shadowRootOptions={mode:`open`},Zm.getTemplateHTML=Jm,N.customElements.get(`media-poster-image`)||N.customElements.define(`media-poster-image`,Zm);var Qm=(e,t,n)=>{if(!t.has(e))throw TypeError(`Cannot `+n)},$m=(e,t,n)=>(Qm(e,t,`read from private field`),n?n.call(e):t.get(e)),eh=(e,t,n)=>{if(t.has(e))throw TypeError(`Cannot add the same private member more than once`);t instanceof WeakSet?t.add(e):t.set(e,n)},th=(e,t,n,r)=>(Qm(e,t,`write to private field`),r?r.call(e,n):t.set(e,n),n),nh,rh=class extends xp{constructor(){super(),eh(this,nh,void 0),th(this,nh,this.shadowRoot.querySelector(`slot`))}static get observedAttributes(){return[...super.observedAttributes,j.MEDIA_PREVIEW_CHAPTER,j.MEDIA_LANG]}attributeChangedCallback(e,t,n){if(super.attributeChangedCallback(e,t,n),(e===j.MEDIA_PREVIEW_CHAPTER||e===j.MEDIA_LANG)&&n!==t&&n!=null){if($m(this,nh).textContent=n,n!==``){let e=M(`chapter: {chapterName}`,{chapterName:n});this.setAttribute(`aria-valuetext`,e)}else this.removeAttribute(`aria-valuetext`)}}get mediaPreviewChapter(){return R(this,j.MEDIA_PREVIEW_CHAPTER)}set mediaPreviewChapter(e){z(this,j.MEDIA_PREVIEW_CHAPTER,e)}};nh=new WeakMap,N.customElements.get(`media-preview-chapter-display`)||N.customElements.define(`media-preview-chapter-display`,rh);var ih=(e,t,n)=>{if(!t.has(e))throw TypeError(`Cannot `+n)},ah=(e,t,n)=>(ih(e,t,`read from private field`),n?n.call(e):t.get(e)),oh=(e,t,n)=>{if(t.has(e))throw TypeError(`Cannot add the same private member more than once`);t instanceof WeakSet?t.add(e):t.set(e,n)},sh=(e,t,n,r)=>(ih(e,t,`write to private field`),r?r.call(e,n):t.set(e,n),n),ch;function lh(e){return`
    <style>
      :host {
        box-sizing: border-box;
        display: var(--media-control-display, var(--media-preview-thumbnail-display, inline-block));
        overflow: hidden;
      }

      img {
        display: none;
        position: relative;
      }
    </style>
    <img crossorigin loading="eager" decoding="async">
  `}var uh=class extends N.HTMLElement{constructor(){if(super(),oh(this,ch,void 0),!this.shadowRoot){this.attachShadow(this.constructor.shadowRootOptions);let e=pc(this.attributes);this.shadowRoot.innerHTML=this.constructor.getTemplateHTML(e)}}static get observedAttributes(){return[A.MEDIA_CONTROLLER,j.MEDIA_PREVIEW_IMAGE,j.MEDIA_PREVIEW_COORDS]}connectedCallback(){var e,t;let n=this.getAttribute(A.MEDIA_CONTROLLER);n&&(sh(this,ch,this.getRootNode()?.getElementById(n)),(t=(e=ah(this,ch))?.associateElement)==null||t.call(e,this))}disconnectedCallback(){var e,t;(t=(e=ah(this,ch))?.unassociateElement)==null||t.call(e,this),sh(this,ch,null)}attributeChangedCallback(e,t,n){var r,i,a,o;[j.MEDIA_PREVIEW_IMAGE,j.MEDIA_PREVIEW_COORDS].includes(e)&&this.update(),e===A.MEDIA_CONTROLLER&&(t&&((i=(r=ah(this,ch))?.unassociateElement)==null||i.call(r,this),sh(this,ch,null)),n&&this.isConnected&&(sh(this,ch,this.getRootNode()?.getElementById(n)),(o=(a=ah(this,ch))?.associateElement)==null||o.call(a,this)))}get mediaPreviewImage(){return R(this,j.MEDIA_PREVIEW_IMAGE)}set mediaPreviewImage(e){z(this,j.MEDIA_PREVIEW_IMAGE,e)}get mediaPreviewCoords(){let e=this.getAttribute(j.MEDIA_PREVIEW_COORDS);if(e)return e.split(/\s+/).map(e=>+e)}set mediaPreviewCoords(e){e?this.setAttribute(j.MEDIA_PREVIEW_COORDS,e.join(` `)):this.removeAttribute(j.MEDIA_PREVIEW_COORDS)}update(){let e=this.mediaPreviewCoords,t=this.mediaPreviewImage;if(!(e&&t))return;let[n,r,i,a]=e,o=t.split(`#`)[0],s=getComputedStyle(this),{maxWidth:c,maxHeight:l,minWidth:u,minHeight:d}=s,f=s.getPropertyValue(`--media-preview-thumbnail-object-fit`).trim()||`contain`,p,m;if(f===`fill`){let e=parseInt(c)/i,t=parseInt(l)/a,n=parseInt(u)/i,r=parseInt(d)/a;p=e<1?e:Math.max(e,n),m=t<1?t:Math.max(t,r)}else{let e=Math.min(parseInt(c)/i,parseInt(l)/a),t=Math.max(parseInt(u)/i,parseInt(d)/a),n=e<1?e:t>1?t:1;p=n,m=n}let{style:h}=Tc(this.shadowRoot,`:host`),ee=Tc(this.shadowRoot,`img`).style,te=this.shadowRoot.querySelector(`img`),ne=Math.min(p,m)<1?`min`:`max`;h.setProperty(`${ne}-width`,`initial`,`important`),h.setProperty(`${ne}-height`,`initial`,`important`),h.width=`${i*p}px`,h.height=`${a*m}px`;let re=()=>{ee.width=`${this.imgWidth*p}px`,ee.height=`${this.imgHeight*m}px`,ee.display=`block`};te.src!==o&&(te.onload=()=>{this.imgWidth=te.naturalWidth,this.imgHeight=te.naturalHeight,re(),te.onload=null},te.src=o,re()),re(),ee.transform=`translate(-${n*p}px, -${r*m}px)`}};ch=new WeakMap,uh.shadowRootOptions={mode:`open`},uh.getTemplateHTML=lh,N.customElements.get(`media-preview-thumbnail`)||N.customElements.define(`media-preview-thumbnail`,uh);var dh=uh,fh=(e,t,n)=>{if(!t.has(e))throw TypeError(`Cannot `+n)},ph=(e,t,n)=>(fh(e,t,`read from private field`),n?n.call(e):t.get(e)),mh=(e,t,n)=>{if(t.has(e))throw TypeError(`Cannot add the same private member more than once`);t instanceof WeakSet?t.add(e):t.set(e,n)},hh=(e,t,n,r)=>(fh(e,t,`write to private field`),r?r.call(e,n):t.set(e,n),n),gh,_h=class extends xp{constructor(){super(),mh(this,gh,void 0),hh(this,gh,this.shadowRoot.querySelector(`slot`)),ph(this,gh).textContent=Qs(0)}static get observedAttributes(){return[...super.observedAttributes,j.MEDIA_PREVIEW_TIME]}attributeChangedCallback(e,t,n){super.attributeChangedCallback(e,t,n),e===j.MEDIA_PREVIEW_TIME&&n!=null&&(ph(this,gh).textContent=Qs(parseFloat(n)))}get mediaPreviewTime(){return P(this,j.MEDIA_PREVIEW_TIME)}set mediaPreviewTime(e){F(this,j.MEDIA_PREVIEW_TIME,e)}};gh=new WeakMap,N.customElements.get(`media-preview-time-display`)||N.customElements.define(`media-preview-time-display`,_h);var vh={SEEK_OFFSET:`seekoffset`},yh=30,bh=e=>`
  <svg aria-hidden="true" viewBox="0 0 20 24">
    <defs>
      <style>.text{font-size:8px;font-family:Arial-BoldMT, Arial;font-weight:700;}</style>
    </defs>
    <text class="text value" transform="translate(2.18 19.87)">${e}</text>
    <path d="M10 6V3L4.37 7 10 10.94V8a5.54 5.54 0 0 1 1.9 10.48v2.12A7.5 7.5 0 0 0 10 6Z"/>
  </svg>`;function xh(e,t){return`
    <slot name="icon">${bh(t.seekOffset)}</slot>
  `}var Sh=(e,t)=>{e.setAttribute(`aria-label`,M(`seek back {seekOffset} seconds`,{seekOffset:t}))};function Ch(){return M(`Seek backward`)}var wh=0,Th=class extends lf{static get observedAttributes(){return[...super.observedAttributes,j.MEDIA_CURRENT_TIME,vh.SEEK_OFFSET]}connectedCallback(){super.connectedCallback(),this.seekOffset=P(this,vh.SEEK_OFFSET,yh)}attributeChangedCallback(e,t,n){super.attributeChangedCallback(e,t,n),Sh(this,this.seekOffset),e===vh.SEEK_OFFSET&&(this.seekOffset=P(this,vh.SEEK_OFFSET,yh))}get seekOffset(){return P(this,vh.SEEK_OFFSET,yh)}set seekOffset(e){F(this,vh.SEEK_OFFSET,e),this.setAttribute(`aria-label`,M(`seek back {seekOffset} seconds`,{seekOffset:this.seekOffset})),gc(vc(this,`icon`),this.seekOffset)}get mediaCurrentTime(){return P(this,j.MEDIA_CURRENT_TIME,wh)}set mediaCurrentTime(e){F(this,j.MEDIA_CURRENT_TIME,e)}handleClick(){let e=Math.max(this.mediaCurrentTime-this.seekOffset,0),t=new N.CustomEvent(k.MEDIA_SEEK_REQUEST,{composed:!0,bubbles:!0,detail:e});this.dispatchEvent(t)}};Th.getSlotTemplateHTML=xh,Th.getTooltipContentHTML=Ch,N.customElements.get(`media-seek-backward-button`)||N.customElements.define(`media-seek-backward-button`,Th);var Eh={SEEK_OFFSET:`seekoffset`},Dh=30,Oh=e=>`
  <svg aria-hidden="true" viewBox="0 0 20 24">
    <defs>
      <style>.text{font-size:8px;font-family:Arial-BoldMT, Arial;font-weight:700;}</style>
    </defs>
    <text class="text value" transform="translate(8.9 19.87)">${e}</text>
    <path d="M10 6V3l5.61 4L10 10.94V8a5.54 5.54 0 0 0-1.9 10.48v2.12A7.5 7.5 0 0 1 10 6Z"/>
  </svg>`;function kh(e,t){return`
    <slot name="icon">${Oh(t.seekOffset)}</slot>
  `}var Ah=(e,t)=>{e.setAttribute(`aria-label`,M(`seek forward {seekOffset} seconds`,{seekOffset:t}))};function jh(){return M(`Seek forward`)}var Mh=0,Nh=class extends lf{static get observedAttributes(){return[...super.observedAttributes,j.MEDIA_CURRENT_TIME,Eh.SEEK_OFFSET]}connectedCallback(){super.connectedCallback(),this.seekOffset=P(this,Eh.SEEK_OFFSET,Dh)}attributeChangedCallback(e,t,n){super.attributeChangedCallback(e,t,n),Ah(this,this.seekOffset),e===Eh.SEEK_OFFSET&&(this.seekOffset=P(this,Eh.SEEK_OFFSET,Dh))}get seekOffset(){return P(this,Eh.SEEK_OFFSET,Dh)}set seekOffset(e){F(this,Eh.SEEK_OFFSET,e),this.setAttribute(`aria-label`,M(`seek forward {seekOffset} seconds`,{seekOffset:this.seekOffset})),gc(vc(this,`icon`),this.seekOffset)}get mediaCurrentTime(){return P(this,j.MEDIA_CURRENT_TIME,Mh)}set mediaCurrentTime(e){F(this,j.MEDIA_CURRENT_TIME,e)}handleClick(){let e=this.mediaCurrentTime+this.seekOffset,t=new N.CustomEvent(k.MEDIA_SEEK_REQUEST,{composed:!0,bubbles:!0,detail:e});this.dispatchEvent(t)}};Nh.getSlotTemplateHTML=kh,Nh.getTooltipContentHTML=jh,N.customElements.get(`media-seek-forward-button`)||N.customElements.define(`media-seek-forward-button`,Nh);var Ph=(e,t,n)=>{if(!t.has(e))throw TypeError(`Cannot `+n)},Fh=(e,t,n)=>(Ph(e,t,`read from private field`),n?n.call(e):t.get(e)),Ih=(e,t,n)=>{if(t.has(e))throw TypeError(`Cannot add the same private member more than once`);t instanceof WeakSet?t.add(e):t.set(e,n)},Lh=(e,t,n,r)=>(Ph(e,t,`write to private field`),r?r.call(e,n):t.set(e,n),n),Rh=(e,t,n)=>(Ph(e,t,`access private method`),n),zh,Bh,Vh,Hh,Uh,Wh,Gh,Kh,qh,Jh,Yh,Xh={REMAINING:`remaining`,SHOW_DURATION:`showduration`,NO_TOGGLE:`notoggle`},Zh=[...Object.values(Xh),j.MEDIA_CURRENT_TIME,j.MEDIA_DURATION,j.MEDIA_SEEKABLE],Qh=[`Enter`,` `],$h=`&nbsp;/&nbsp;`,eg=(e,{timesSep:t=$h}={})=>{let n=e.mediaCurrentTime??0,[,r]=e.mediaSeekable??[],i=0;Number.isFinite(e.mediaDuration)?i=e.mediaDuration:Number.isFinite(r)&&(i=r);let a=e.remaining?Qs(0-(i-n)):Qs(n);return e.showDuration?`${a}${t}${Qs(i)}`:a},tg=e=>{let t=e.mediaCurrentTime,[,n]=e.mediaSeekable??[],r=null;if(Number.isFinite(e.mediaDuration)?r=e.mediaDuration:Number.isFinite(n)&&(r=n),t==null||r===null){e.setAttribute(`aria-description`,M(`video not loaded, unknown time.`));return}let i=e.remaining?Zs(0-(r-t)):Zs(t);if(!e.showDuration){e.setAttribute(`aria-description`,i);return}let a=M(`{currentTime} of {totalTime}`,{currentTime:i,totalTime:Zs(r)});e.setAttribute(`aria-description`,a)};function ng(e,t){return`
    <slot>${eg(t)}</slot>
  `}var rg=e=>{e.setAttribute(`aria-label`,M(`playback time`))},ig=class extends xp{constructor(){super(),Ih(this,Hh),Ih(this,Wh),Ih(this,Kh),Ih(this,Jh),Ih(this,zh,void 0),Ih(this,Bh,null),Ih(this,Vh,e=>{let{metaKey:t,altKey:n,key:r}=e;t||n||!Qh.includes(r)?this.removeEventListener(`keyup`,Fh(this,Bh)):this.addEventListener(`keyup`,Fh(this,Bh))}),Lh(this,zh,this.shadowRoot.querySelector(`slot`)),Fh(this,zh).innerHTML=`${eg(this)}`}static get observedAttributes(){return[...super.observedAttributes,...Zh,`disabled`]}connectedCallback(){let{style:e}=Tc(this.shadowRoot,`:host(:hover:not([notoggle]))`);e.setProperty(`cursor`,`var(--media-cursor, pointer)`),e.setProperty(`background`,`var(--media-control-hover-background, rgba(50 50 70 / .7))`),this.setAttribute(`aria-label`,M(`playback time`)),Rh(this,Kh,qh).call(this),super.connectedCallback()}toggleTimeDisplay(){this.noToggle||(this.hasAttribute(`remaining`)?this.removeAttribute(`remaining`):this.setAttribute(`remaining`,``))}disconnectedCallback(){this.disable(),Rh(this,Wh,Gh).call(this),super.disconnectedCallback()}attributeChangedCallback(e,t,n){rg(this),Zh.includes(e)?this.update():e===`disabled`&&n!==t?n==null?Rh(this,Kh,qh).call(this):Rh(this,Jh,Yh).call(this):e===Xh.NO_TOGGLE&&n!==t&&(this.noToggle?Rh(this,Jh,Yh).call(this):Rh(this,Kh,qh).call(this)),super.attributeChangedCallback(e,t,n)}enable(){this.noToggle||(this.tabIndex=0)}disable(){this.tabIndex=-1}get remaining(){return I(this,Xh.REMAINING)}set remaining(e){L(this,Xh.REMAINING,e)}get showDuration(){return I(this,Xh.SHOW_DURATION)}set showDuration(e){L(this,Xh.SHOW_DURATION,e)}get noToggle(){return I(this,Xh.NO_TOGGLE)}set noToggle(e){L(this,Xh.NO_TOGGLE,e)}get mediaDuration(){return P(this,j.MEDIA_DURATION)}set mediaDuration(e){F(this,j.MEDIA_DURATION,e)}get mediaCurrentTime(){return P(this,j.MEDIA_CURRENT_TIME)}set mediaCurrentTime(e){F(this,j.MEDIA_CURRENT_TIME,e)}get mediaSeekable(){let e=this.getAttribute(j.MEDIA_SEEKABLE);if(e)return e.split(`:`).map(e=>+e)}set mediaSeekable(e){e==null?this.removeAttribute(j.MEDIA_SEEKABLE):this.setAttribute(j.MEDIA_SEEKABLE,e.join(`:`))}update(){let e=eg(this);tg(this),e!==Fh(this,zh).innerHTML&&(Fh(this,zh).innerHTML=e)}};zh=new WeakMap,Bh=new WeakMap,Vh=new WeakMap,Hh=new WeakSet,Uh=function(){Fh(this,Bh)||(Lh(this,Bh,e=>{let{key:t}=e;Qh.includes(t)?this.toggleTimeDisplay():this.removeEventListener(`keyup`,Fh(this,Bh))}),this.addEventListener(`keydown`,Fh(this,Vh)),this.addEventListener(`click`,this.toggleTimeDisplay))},Wh=new WeakSet,Gh=function(){Fh(this,Bh)&&(this.removeEventListener(`keyup`,Fh(this,Bh)),this.removeEventListener(`keydown`,Fh(this,Vh)),this.removeEventListener(`click`,this.toggleTimeDisplay),Lh(this,Bh,null))},Kh=new WeakSet,qh=function(){!this.noToggle&&!this.hasAttribute(`disabled`)&&(this.setAttribute(`role`,`button`),this.enable(),Rh(this,Hh,Uh).call(this))},Jh=new WeakSet,Yh=function(){this.removeAttribute(`role`),this.disable(),Rh(this,Wh,Gh).call(this)},ig.getSlotTemplateHTML=ng,N.customElements.get(`media-time-display`)||N.customElements.define(`media-time-display`,ig);var ag=(e,t,n)=>{if(!t.has(e))throw TypeError(`Cannot `+n)},og=(e,t,n)=>(ag(e,t,`read from private field`),n?n.call(e):t.get(e)),sg=(e,t,n)=>{if(t.has(e))throw TypeError(`Cannot add the same private member more than once`);t instanceof WeakSet?t.add(e):t.set(e,n)},cg=(e,t,n,r)=>(ag(e,t,`write to private field`),r?r.call(e,n):t.set(e,n),n),lg=(e,t,n,r)=>({set _(r){cg(e,t,r,n)},get _(){return og(e,t,r)}}),ug,dg,fg,pg,mg,hg,gg,_g,vg,yg,bg=class{constructor(e,t,n){sg(this,ug,void 0),sg(this,dg,void 0),sg(this,fg,void 0),sg(this,pg,void 0),sg(this,mg,void 0),sg(this,hg,void 0),sg(this,gg,void 0),sg(this,_g,void 0),sg(this,vg,0),sg(this,yg,(e=performance.now())=>{cg(this,vg,requestAnimationFrame(og(this,yg))),cg(this,pg,performance.now()-og(this,fg));let t=1e3/this.fps;if(og(this,pg)>t){cg(this,fg,e-og(this,pg)%t);let n=1e3/((e-og(this,dg))/++lg(this,mg)._),r=(e-og(this,hg))/1e3/this.duration,i=og(this,gg)+r*this.playbackRate;i-og(this,ug).valueAsNumber>0?cg(this,_g,this.playbackRate/this.duration/n):(cg(this,_g,.995*og(this,_g)),i=og(this,ug).valueAsNumber+og(this,_g)),this.callback(i)}}),cg(this,ug,e),this.callback=t,this.fps=n}start(){og(this,vg)===0&&(cg(this,fg,performance.now()),cg(this,dg,og(this,fg)),cg(this,mg,0),og(this,yg).call(this))}stop(){og(this,vg)!==0&&(cancelAnimationFrame(og(this,vg)),cg(this,vg,0))}update({start:e,duration:t,playbackRate:n}){let r=e-og(this,ug).valueAsNumber,i=Math.abs(t-this.duration);(r>0||r<-.5/t||i>=.5)&&this.callback(e),cg(this,gg,e),cg(this,hg,performance.now()),this.duration=t,this.playbackRate=n}};ug=new WeakMap,dg=new WeakMap,fg=new WeakMap,pg=new WeakMap,mg=new WeakMap,hg=new WeakMap,gg=new WeakMap,_g=new WeakMap,vg=new WeakMap,yg=new WeakMap;var xg=(e,t,n)=>{if(!t.has(e))throw TypeError(`Cannot `+n)},G=(e,t,n)=>(xg(e,t,`read from private field`),n?n.call(e):t.get(e)),Sg=(e,t,n)=>{if(t.has(e))throw TypeError(`Cannot add the same private member more than once`);t instanceof WeakSet?t.add(e):t.set(e,n)},Cg=(e,t,n,r)=>(xg(e,t,`write to private field`),r?r.call(e,n):t.set(e,n),n),wg=(e,t,n)=>(xg(e,t,`access private method`),n),Tg,Eg,Dg,Og,kg,Ag,jg,Mg,Ng,Pg,Fg,Ig,Lg,Rg,zg,Bg,Vg,Hg,Ug,Wg,Gg,Kg,qg,Jg,Yg,Xg,Zg=e=>{let t=e.range,n=Zs(+e_(e)),r=Zs(+e.mediaSeekableEnd),i=n&&r?M(`{currentTime} of {totalTime}`,{currentTime:n,totalTime:r}):M(`video not loaded, unknown time.`);t.setAttribute(`aria-valuetext`,i)};function Qg(e){return`
    <style>
      :host {
        --media-box-border-radius: 4px;
        --media-box-padding-left: 10px;
        --media-box-padding-right: 10px;
        --media-preview-border-radius: var(--media-box-border-radius);
        --media-box-arrow-offset: var(--media-box-border-radius);
        --_control-background: var(--media-control-background, var(--media-secondary-color, rgb(20 20 30 / .7)));
        --_preview-background: var(--media-preview-background, var(--_control-background));

        
        contain: layout;
      }

      #buffered {
        background: var(--media-time-range-buffered-color, rgb(255 255 255 / .4));
        position: absolute;
        height: 100%;
        will-change: width;
      }

      #preview-rail,
      #current-rail {
        width: 100%;
        position: absolute;
        left: 0;
        bottom: 100%;
        pointer-events: none;
        will-change: transform;
      }

      [part~="box"] {
        width: min-content;
        
        position: absolute;
        bottom: 100%;
        flex-direction: column;
        align-items: center;
        transform: translateX(-50%);
      }

      [part~="current-box"] {
        display: var(--media-current-box-display, var(--media-box-display, flex));
        margin: var(--media-current-box-margin, var(--media-box-margin, 0 0 5px));
        visibility: hidden;
      }

      [part~="preview-box"] {
        display: var(--media-preview-box-display, var(--media-box-display, flex));
        margin: var(--media-preview-box-margin, var(--media-box-margin, 0 0 5px));
        transition-property: var(--media-preview-transition-property, visibility, opacity);
        transition-duration: var(--media-preview-transition-duration-out, .25s);
        transition-delay: var(--media-preview-transition-delay-out, 0s);
        visibility: hidden;
        opacity: 0;
      }

      :host(:is([${j.MEDIA_PREVIEW_IMAGE}], [${j.MEDIA_PREVIEW_TIME}])[dragging]) [part~="preview-box"] {
        transition-duration: var(--media-preview-transition-duration-in, .5s);
        transition-delay: var(--media-preview-transition-delay-in, .25s);
        visibility: visible;
        opacity: 1;
      }

      @media (hover: hover) {
        :host(:is([${j.MEDIA_PREVIEW_IMAGE}], [${j.MEDIA_PREVIEW_TIME}]):hover) [part~="preview-box"] {
          transition-duration: var(--media-preview-transition-duration-in, .5s);
          transition-delay: var(--media-preview-transition-delay-in, .25s);
          visibility: visible;
          opacity: 1;
        }
      }

      media-preview-thumbnail,
      ::slotted(media-preview-thumbnail) {
        visibility: hidden;
        
        transition: visibility 0s .25s;
        transition-delay: calc(var(--media-preview-transition-delay-out, 0s) + var(--media-preview-transition-duration-out, .25s));
        background: var(--media-preview-thumbnail-background, var(--_preview-background));
        box-shadow: var(--media-preview-thumbnail-box-shadow, 0 0 4px rgb(0 0 0 / .2));
        max-width: var(--media-preview-thumbnail-max-width, 180px);
        max-height: var(--media-preview-thumbnail-max-height, 160px);
        min-width: var(--media-preview-thumbnail-min-width, 120px);
        min-height: var(--media-preview-thumbnail-min-height, 80px);
        border: var(--media-preview-thumbnail-border);
        border-radius: var(--media-preview-thumbnail-border-radius,
          var(--media-preview-border-radius) var(--media-preview-border-radius) 0 0);
      }

      :host([${j.MEDIA_PREVIEW_IMAGE}][dragging]) media-preview-thumbnail,
      :host([${j.MEDIA_PREVIEW_IMAGE}][dragging]) ::slotted(media-preview-thumbnail) {
        transition-delay: var(--media-preview-transition-delay-in, .25s);
        visibility: visible;
      }

      @media (hover: hover) {
        :host([${j.MEDIA_PREVIEW_IMAGE}]:hover) media-preview-thumbnail,
        :host([${j.MEDIA_PREVIEW_IMAGE}]:hover) ::slotted(media-preview-thumbnail) {
          transition-delay: var(--media-preview-transition-delay-in, .25s);
          visibility: visible;
        }

        :host([${j.MEDIA_PREVIEW_TIME}]:hover) {
          --media-time-range-hover-display: block;
        }
      }

      media-preview-chapter-display,
      ::slotted(media-preview-chapter-display) {
        font-size: var(--media-font-size, 13px);
        line-height: 17px;
        min-width: 0;
        visibility: hidden;
        
        transition: min-width 0s, border-radius 0s, margin 0s, padding 0s, visibility 0s;
        transition-delay: calc(var(--media-preview-transition-delay-out, 0s) + var(--media-preview-transition-duration-out, .25s));
        background: var(--media-preview-chapter-background, var(--_preview-background));
        border-radius: var(--media-preview-chapter-border-radius,
          var(--media-preview-border-radius) var(--media-preview-border-radius)
          var(--media-preview-border-radius) var(--media-preview-border-radius));
        padding: var(--media-preview-chapter-padding, 3.5px 9px);
        margin: var(--media-preview-chapter-margin, 0 0 5px);
        text-shadow: var(--media-preview-chapter-text-shadow, 0 0 4px rgb(0 0 0 / .75));
      }

      :host([${j.MEDIA_PREVIEW_IMAGE}]) media-preview-chapter-display,
      :host([${j.MEDIA_PREVIEW_IMAGE}]) ::slotted(media-preview-chapter-display) {
        transition-delay: var(--media-preview-transition-delay-in, .25s);
        border-radius: var(--media-preview-chapter-border-radius, 0);
        padding: var(--media-preview-chapter-padding, 3.5px 9px 0);
        margin: var(--media-preview-chapter-margin, 0);
        min-width: 100%;
      }

      media-preview-chapter-display[${j.MEDIA_PREVIEW_CHAPTER}],
      ::slotted(media-preview-chapter-display[${j.MEDIA_PREVIEW_CHAPTER}]) {
        visibility: visible;
      }

      media-preview-chapter-display:not([aria-valuetext]),
      ::slotted(media-preview-chapter-display:not([aria-valuetext])) {
        display: none;
      }

      media-preview-time-display,
      ::slotted(media-preview-time-display),
      media-time-display,
      ::slotted(media-time-display) {
        font-size: var(--media-font-size, 13px);
        line-height: 17px;
        min-width: 0;
        
        transition: min-width 0s, border-radius 0s;
        transition-delay: calc(var(--media-preview-transition-delay-out, 0s) + var(--media-preview-transition-duration-out, .25s));
        background: var(--media-preview-time-background, var(--_preview-background));
        border-radius: var(--media-preview-time-border-radius,
          var(--media-preview-border-radius) var(--media-preview-border-radius)
          var(--media-preview-border-radius) var(--media-preview-border-radius));
        padding: var(--media-preview-time-padding, 3.5px 9px);
        margin: var(--media-preview-time-margin, 0);
        text-shadow: var(--media-preview-time-text-shadow, 0 0 4px rgb(0 0 0 / .75));
        transform: translateX(min(
          max(calc(50% - var(--_box-width) / 2),
          calc(var(--_box-shift, 0))),
          calc(var(--_box-width) / 2 - 50%)
        ));
      }

      :host([${j.MEDIA_PREVIEW_IMAGE}]) media-preview-time-display,
      :host([${j.MEDIA_PREVIEW_IMAGE}]) ::slotted(media-preview-time-display) {
        transition-delay: var(--media-preview-transition-delay-in, .25s);
        border-radius: var(--media-preview-time-border-radius,
          0 0 var(--media-preview-border-radius) var(--media-preview-border-radius));
        min-width: 100%;
      }

      :host([${j.MEDIA_PREVIEW_TIME}]:hover) {
        --media-time-range-hover-display: block;
      }

      [part~="arrow"],
      ::slotted([part~="arrow"]) {
        display: var(--media-box-arrow-display, inline-block);
        transform: translateX(min(
          max(calc(50% - var(--_box-width) / 2 + var(--media-box-arrow-offset)),
          calc(var(--_box-shift, 0))),
          calc(var(--_box-width) / 2 - 50% - var(--media-box-arrow-offset))
        ));
        
        border-color: transparent;
        border-top-color: var(--media-box-arrow-background, var(--_control-background));
        border-width: var(--media-box-arrow-border-width,
          var(--media-box-arrow-height, 5px) var(--media-box-arrow-width, 6px) 0);
        border-style: solid;
        justify-content: center;
        height: 0;
      }
    </style>
    <div id="preview-rail">
      <slot name="preview" part="box preview-box">
        <media-preview-thumbnail>
          <template shadowrootmode="${dh.shadowRootOptions.mode}">
            ${dh.getTemplateHTML({})}
          </template>
        </media-preview-thumbnail>
        <media-preview-chapter-display></media-preview-chapter-display>
        <media-preview-time-display></media-preview-time-display>
        <slot name="preview-arrow"><div part="arrow"></div></slot>
      </slot>
    </div>
    <div id="current-rail">
      <slot name="current" part="box current-box">
        
      </slot>
    </div>
  `}var $g=(e,t=e.mediaCurrentTime)=>{let n=Number.isFinite(e.mediaSeekableStart)?e.mediaSeekableStart:0,r=Number.isFinite(e.mediaDuration)?e.mediaDuration:e.mediaSeekableEnd;if(Number.isNaN(r))return 0;let i=(t-n)/(r-n);return Math.max(0,Math.min(i,1))},e_=(e,t=e.range.valueAsNumber)=>{let n=Number.isFinite(e.mediaSeekableStart)?e.mediaSeekableStart:0,r=Number.isFinite(e.mediaDuration)?e.mediaDuration:e.mediaSeekableEnd;return Number.isNaN(r)?0:t*(r-n)+n},t_=class extends op{constructor(){super(),Sg(this,Ig),Sg(this,zg),Sg(this,Vg),Sg(this,Ug),Sg(this,Gg),Sg(this,qg),Sg(this,Yg),Sg(this,Tg,null),Sg(this,Eg,void 0),Sg(this,Dg,void 0),Sg(this,Og,void 0),Sg(this,kg,void 0),Sg(this,Ag,void 0),Sg(this,jg,void 0),Sg(this,Mg,void 0),Sg(this,Ng,void 0),Sg(this,Pg,void 0),Sg(this,Fg,()=>{wg(this,Ig,Lg).call(this)?G(this,Eg).start():G(this,Eg).stop()}),Sg(this,Rg,e=>{this.dragging||(zs(e)&&(this.range.valueAsNumber=e),G(this,Pg)||this.updateBar())}),this.shadowRoot.querySelector(`#track`).insertAdjacentHTML(`afterbegin`,`<div id="buffered" part="buffered"></div>`),Cg(this,Dg,this.shadowRoot.querySelectorAll(`[part~="box"]`)),Cg(this,kg,this.shadowRoot.querySelector(`[part~="preview-box"]`)),Cg(this,Ag,this.shadowRoot.querySelector(`[part~="current-box"]`));let e=getComputedStyle(this);Cg(this,jg,parseInt(e.getPropertyValue(`--media-box-padding-left`))),Cg(this,Mg,parseInt(e.getPropertyValue(`--media-box-padding-right`))),Cg(this,Eg,new bg(this.range,G(this,Rg),60))}static get observedAttributes(){return[...super.observedAttributes,j.MEDIA_PAUSED,j.MEDIA_DURATION,j.MEDIA_SEEKABLE,j.MEDIA_CURRENT_TIME,j.MEDIA_PREVIEW_IMAGE,j.MEDIA_PREVIEW_TIME,j.MEDIA_PREVIEW_CHAPTER,j.MEDIA_BUFFERED,j.MEDIA_PLAYBACK_RATE,j.MEDIA_LOADING,j.MEDIA_ENDED]}connectedCallback(){var e;super.connectedCallback(),this.range.setAttribute(`aria-label`,M(`seek`)),G(this,Fg).call(this),Cg(this,Tg,this.getRootNode()),(e=G(this,Tg))==null||e.addEventListener(`transitionstart`,this)}disconnectedCallback(){var e;super.disconnectedCallback(),G(this,Eg).stop(),(e=G(this,Tg))==null||e.removeEventListener(`transitionstart`,this),Cg(this,Tg,null)}attributeChangedCallback(e,t,n){super.attributeChangedCallback(e,t,n),t!=n&&(e===j.MEDIA_CURRENT_TIME||e===j.MEDIA_PAUSED||e===j.MEDIA_ENDED||e===j.MEDIA_LOADING||e===j.MEDIA_DURATION||e===j.MEDIA_SEEKABLE?(G(this,Eg).update({start:$g(this),duration:this.mediaSeekableEnd-this.mediaSeekableStart,playbackRate:this.mediaPlaybackRate}),G(this,Fg).call(this),Zg(this)):e===j.MEDIA_BUFFERED&&this.updateBufferedBar(),(e===j.MEDIA_DURATION||e===j.MEDIA_SEEKABLE)&&(this.mediaChaptersCues=G(this,Ng),this.updateBar()))}get mediaChaptersCues(){return G(this,Ng)}set mediaChaptersCues(e){Cg(this,Ng,e),this.updateSegments(G(this,Ng)?.map(e=>({start:$g(this,e.startTime),end:$g(this,e.endTime)})))}get mediaPaused(){return I(this,j.MEDIA_PAUSED)}set mediaPaused(e){L(this,j.MEDIA_PAUSED,e)}get mediaLoading(){return I(this,j.MEDIA_LOADING)}set mediaLoading(e){L(this,j.MEDIA_LOADING,e)}get mediaDuration(){return P(this,j.MEDIA_DURATION)}set mediaDuration(e){F(this,j.MEDIA_DURATION,e)}get mediaCurrentTime(){return P(this,j.MEDIA_CURRENT_TIME)}set mediaCurrentTime(e){F(this,j.MEDIA_CURRENT_TIME,e)}get mediaPlaybackRate(){return P(this,j.MEDIA_PLAYBACK_RATE,1)}set mediaPlaybackRate(e){F(this,j.MEDIA_PLAYBACK_RATE,e)}get mediaBuffered(){let e=this.getAttribute(j.MEDIA_BUFFERED);return e?e.split(` `).map(e=>e.split(`:`).map(e=>+e)):[]}set mediaBuffered(e){if(!e){this.removeAttribute(j.MEDIA_BUFFERED);return}let t=e.map(e=>e.join(`:`)).join(` `);this.setAttribute(j.MEDIA_BUFFERED,t)}get mediaSeekable(){let e=this.getAttribute(j.MEDIA_SEEKABLE);if(e)return e.split(`:`).map(e=>+e)}set mediaSeekable(e){e==null?this.removeAttribute(j.MEDIA_SEEKABLE):this.setAttribute(j.MEDIA_SEEKABLE,e.join(`:`))}get mediaSeekableEnd(){let[,e=this.mediaDuration]=this.mediaSeekable??[];return e}get mediaSeekableStart(){let[e=0]=this.mediaSeekable??[];return e}get mediaPreviewImage(){return R(this,j.MEDIA_PREVIEW_IMAGE)}set mediaPreviewImage(e){z(this,j.MEDIA_PREVIEW_IMAGE,e)}get mediaPreviewTime(){return P(this,j.MEDIA_PREVIEW_TIME)}set mediaPreviewTime(e){F(this,j.MEDIA_PREVIEW_TIME,e)}get mediaEnded(){return I(this,j.MEDIA_ENDED)}set mediaEnded(e){L(this,j.MEDIA_ENDED,e)}updateBar(){super.updateBar(),this.updateBufferedBar(),this.updateCurrentBox()}updateBufferedBar(){let e=this.mediaBuffered;if(!e.length)return;let t;if(this.mediaEnded)t=1;else{let n=this.mediaCurrentTime,[,r=this.mediaSeekableStart]=e.find(([e,t])=>e<=n&&n<=t)??[];t=$g(this,r)}let{style:n}=Tc(this.shadowRoot,`#buffered`);n.setProperty(`width`,`${t*100}%`)}updateCurrentBox(){if(!this.shadowRoot.querySelector(`slot[name="current"]`).assignedElements().length)return;let e=Tc(this.shadowRoot,`#current-rail`),t=Tc(this.shadowRoot,`[part~="current-box"]`),n=wg(this,zg,Bg).call(this,G(this,Ag)),r=wg(this,Vg,Hg).call(this,n,this.range.valueAsNumber),i=wg(this,Ug,Wg).call(this,n,this.range.valueAsNumber);e.style.transform=`translateX(${r})`,e.style.setProperty(`--_range-width`,`${n.range.width}`),t.style.setProperty(`--_box-shift`,`${i}`),t.style.setProperty(`--_box-width`,`${n.box.width}px`),t.style.setProperty(`visibility`,`initial`)}handleEvent(e){switch(super.handleEvent(e),e.type){case`input`:wg(this,Yg,Xg).call(this);break;case`pointermove`:wg(this,Gg,Kg).call(this,e);break;case`pointerup`:G(this,Pg)&&Cg(this,Pg,!1);break;case`pointerdown`:Cg(this,Pg,!0);break;case`pointerleave`:wg(this,qg,Jg).call(this,null);break;case`transitionstart`:yc(e.target,this)&&setTimeout(()=>G(this,Fg).call(this),0)}}};Tg=new WeakMap,Eg=new WeakMap,Dg=new WeakMap,Og=new WeakMap,kg=new WeakMap,Ag=new WeakMap,jg=new WeakMap,Mg=new WeakMap,Ng=new WeakMap,Pg=new WeakMap,Fg=new WeakMap,Ig=new WeakSet,Lg=function(){return this.isConnected&&!this.mediaPaused&&!this.mediaLoading&&!this.mediaEnded&&this.mediaSeekableEnd>0&&Cc(this)},Rg=new WeakMap,zg=new WeakSet,Bg=function(e){let t=((this.getAttribute(`bounds`)?bc(this,`#${this.getAttribute(`bounds`)}`):this.parentElement)??this).getBoundingClientRect(),n=this.range.getBoundingClientRect(),r=e.offsetWidth;return{box:{width:r,min:-(n.left-t.left-r/2),max:t.right-n.left-r/2},bounds:t,range:n}},Vg=new WeakSet,Hg=function(e,t){let n=`${t*100}%`,{width:r,min:i,max:a}=e.box;if(!r)return n;if(Number.isNaN(i)||(n=`max(${`calc(1 / var(--_range-width) * 100 * ${i}% + var(--media-box-padding-left))`}, ${n})`),!Number.isNaN(a)){let e=`calc(1 / var(--_range-width) * 100 * ${a}% - var(--media-box-padding-right))`;n=`min(${n}, ${e})`}return n},Ug=new WeakSet,Wg=function(e,t){let{width:n,min:r,max:i}=e.box,a=t*e.range.width;if(a<r+G(this,jg)){let t=e.range.left-e.bounds.left-G(this,jg);return`${a-n/2+t}px`}if(a>i-G(this,Mg)){let t=e.bounds.right-e.range.right-G(this,Mg);return`${a+n/2-t-e.range.width}px`}return 0},Gg=new WeakSet,Kg=function(e){let t=[...G(this,Dg)].some(t=>e.composedPath().includes(t));if(!this.dragging&&(t||!e.composedPath().includes(this))){wg(this,qg,Jg).call(this,null);return}let n=this.mediaSeekableEnd;if(!n)return;let r=Tc(this.shadowRoot,`#preview-rail`),i=Tc(this.shadowRoot,`[part~="preview-box"]`),a=wg(this,zg,Bg).call(this,G(this,kg)),o=(e.clientX-a.range.left)/a.range.width;o=Math.max(0,Math.min(1,o));let s=wg(this,Vg,Hg).call(this,a,o),c=wg(this,Ug,Wg).call(this,a,o);r.style.transform=`translateX(${s})`,r.style.setProperty(`--_range-width`,`${a.range.width}`),i.style.setProperty(`--_box-shift`,`${c}`),i.style.setProperty(`--_box-width`,`${a.box.width}px`);let l=Math.round(G(this,Og))-Math.round(o*n);Math.abs(l)<1&&o>.01&&o<.99||(Cg(this,Og,o*n),wg(this,qg,Jg).call(this,G(this,Og)))},qg=new WeakSet,Jg=function(e){this.dispatchEvent(new N.CustomEvent(k.MEDIA_PREVIEW_REQUEST,{composed:!0,bubbles:!0,detail:e}))},Yg=new WeakSet,Xg=function(){G(this,Eg).stop();let e=e_(this);this.dispatchEvent(new N.CustomEvent(k.MEDIA_SEEK_REQUEST,{composed:!0,bubbles:!0,detail:e}))},t_.shadowRootOptions={mode:`open`},t_.getContainerTemplateHTML=Qg,N.customElements.get(`media-time-range`)||N.customElements.define(`media-time-range`,t_);var n_=(e,t,n)=>{if(!t.has(e))throw TypeError(`Cannot `+n)},r_=(e,t,n)=>(n_(e,t,`read from private field`),n?n.call(e):t.get(e)),i_=(e,t,n)=>{if(t.has(e))throw TypeError(`Cannot add the same private member more than once`);t instanceof WeakSet?t.add(e):t.set(e,n)},a_,o_=1,s_=e=>e.mediaMuted?0:e.mediaVolume,c_=e=>`${Math.round(e*100)}%`,l_=class extends op{constructor(){super(...arguments),i_(this,a_,()=>{let e=this.range.value,t=new N.CustomEvent(k.MEDIA_VOLUME_REQUEST,{composed:!0,bubbles:!0,detail:e});this.dispatchEvent(t)})}static get observedAttributes(){return[...super.observedAttributes,j.MEDIA_VOLUME,j.MEDIA_MUTED,j.MEDIA_VOLUME_UNAVAILABLE]}connectedCallback(){super.connectedCallback(),this.range.setAttribute(`aria-label`,M(`volume`)),this.range.addEventListener(`input`,r_(this,a_))}disconnectedCallback(){this.range.removeEventListener(`input`,r_(this,a_)),super.disconnectedCallback()}attributeChangedCallback(e,t,n){super.attributeChangedCallback(e,t,n),(e===j.MEDIA_VOLUME||e===j.MEDIA_MUTED)&&(this.range.valueAsNumber=s_(this),this.range.setAttribute(`aria-valuetext`,c_(this.range.valueAsNumber)),this.updateBar())}get mediaVolume(){return P(this,j.MEDIA_VOLUME,o_)}set mediaVolume(e){F(this,j.MEDIA_VOLUME,e)}get mediaMuted(){return I(this,j.MEDIA_MUTED)}set mediaMuted(e){L(this,j.MEDIA_MUTED,e)}get mediaVolumeUnavailable(){return R(this,j.MEDIA_VOLUME_UNAVAILABLE)}set mediaVolumeUnavailable(e){z(this,j.MEDIA_VOLUME_UNAVAILABLE,e)}};a_=new WeakMap,N.customElements.get(`media-volume-range`)||N.customElements.define(`media-volume-range`,l_);function u_(e){return`
      <style>
        :host {
          min-width: 4ch;
          padding: var(--media-button-padding, var(--media-control-padding, 10px 5px));
          width: 100%;
          display: grid;
          grid-template-columns: 1fr auto;
          gap: 1rem;
          font-weight: var(--media-button-font-weight, normal);
        }

        #checked-indicator {
          display: none;
        }

        :host([${j.MEDIA_LOOP}]) #checked-indicator {
          display: block;
        }
      </style>
      
      <span id="icon">
     </span>

      <div id="checked-indicator">
        <svg aria-hidden="true" viewBox="0 1 24 24" part="checked-indicator indicator">
          <path d="m10 15.17 9.193-9.191 1.414 1.414-10.606 10.606-6.364-6.364 1.414-1.414 4.95 4.95Z"/>
        </svg>
      </div>
    `}function d_(){return M(`Loop`)}var f_=class extends lf{constructor(){super(...arguments),this.container=null}static get observedAttributes(){return[...super.observedAttributes,j.MEDIA_LOOP]}connectedCallback(){super.connectedCallback(),this.container=this.shadowRoot?.querySelector(`#icon`)||null,this.container&&(this.container.textContent=M(`Loop`))}attributeChangedCallback(e,t,n){super.attributeChangedCallback(e,t,n),e===j.MEDIA_LOOP&&this.container&&this.setAttribute(`aria-checked`,this.mediaLoop?`true`:`false`)}get mediaLoop(){return I(this,j.MEDIA_LOOP)}set mediaLoop(e){L(this,j.MEDIA_LOOP,e)}handleClick(){let e=!this.mediaLoop,t=new N.CustomEvent(k.MEDIA_LOOP_REQUEST,{composed:!0,bubbles:!0,detail:e});this.dispatchEvent(t)}};f_.getSlotTemplateHTML=u_,f_.getTooltipContentHTML=d_,N.customElements.get(`media-loop-button`)||N.customElements.define(`media-loop-button`,f_);var p_=(e,t,n)=>{if(!t.has(e))throw TypeError(`Cannot `+n)},K=(e,t,n)=>(p_(e,t,`read from private field`),n?n.call(e):t.get(e)),m_=(e,t,n)=>{if(t.has(e))throw TypeError(`Cannot add the same private member more than once`);t instanceof WeakSet?t.add(e):t.set(e,n)},h_=(e,t,n,r)=>(p_(e,t,`write to private field`),r?r.call(e,n):t.set(e,n),n),g_,__,v_,y_,b_,x_,S_,C_,w_,T_,E_,D_=1,O_=0,k_=1,A_={processCallback(e,t,n){if(n){for(let[e,r]of t)if(e in n){let t=n[e];typeof t==`boolean`&&r instanceof z_&&typeof r.element[r.attributeName]==`boolean`?r.booleanValue=t:typeof t==`function`&&r instanceof z_?r.element[r.attributeName]=t:r.value=t}}}},j_=class extends N.DocumentFragment{constructor(e,t,n=A_){var r;super(),m_(this,g_,void 0),m_(this,__,void 0),this.append(e.content.cloneNode(!0)),h_(this,g_,M_(this)),h_(this,__,n),(r=n.createCallback)==null||r.call(n,this,K(this,g_),t),n.processCallback(this,K(this,g_),t)}update(e){K(this,__).processCallback(this,K(this,g_),e)}};g_=new WeakMap,__=new WeakMap;var M_=(e,t=[])=>{let n,r;for(let i of e.attributes||[])if(i.value.includes(`{{`)){let a=new R_;for([n,r]of P_(i.value))if(!n)a.append(r);else{let n=new z_(e,i.name,i.namespaceURI);a.append(n),t.push([r,n])}i.value=a.toString()}for(let i of e.childNodes)if(i.nodeType===D_&&!(i instanceof HTMLTemplateElement))M_(i,t);else{let a=i.data;if(i.nodeType===D_||a.includes(`{{`)){let o=[];if(a)for([n,r]of P_(a))if(!n)o.push(new Text(r));else{let n=new B_(e);o.push(n),t.push([r,n])}else if(i instanceof HTMLTemplateElement){let n=new V_(e,i);o.push(n),t.push([n.expression,n])}i.replaceWith(...o.flatMap(e=>e.replacementNodes||[e]))}}return t},N_={},P_=e=>{let t=``,n=0,r=N_[e],i=0,a;if(r)return r;for(r=[];a=e[i];i++)a===`{`&&e[i+1]===`{`&&e[i-1]!==`\\`&&e[i+2]&&++n==1?(t&&r.push([O_,t]),t=``,i++):a===`}`&&e[i+1]===`}`&&e[i-1]!==`\\`&&!--n?(r.push([k_,t.trim()]),t=``,i++):t+=a||``;return t&&r.push([O_,(n>0?`{{`:``)+t]),N_[e]=r},F_=11,I_=class{get value(){return``}set value(e){}toString(){return this.value}},L_=new WeakMap,R_=class{constructor(){m_(this,v_,[])}[Symbol.iterator](){return K(this,v_).values()}get length(){return K(this,v_).length}item(e){return K(this,v_)[e]}append(...e){for(let t of e)t instanceof z_&&L_.set(t,this),K(this,v_).push(t)}toString(){return K(this,v_).join(``)}};v_=new WeakMap;var z_=class extends I_{constructor(e,t,n){super(),m_(this,C_),m_(this,y_,``),m_(this,b_,void 0),m_(this,x_,void 0),m_(this,S_,void 0),h_(this,b_,e),h_(this,x_,t),h_(this,S_,n)}get attributeName(){return K(this,x_)}get attributeNamespace(){return K(this,S_)}get element(){return K(this,b_)}get value(){return K(this,y_)}set value(e){K(this,y_)!==e&&(h_(this,y_,e),!K(this,C_,w_)||K(this,C_,w_).length===1?e==null?K(this,b_).removeAttributeNS(K(this,S_),K(this,x_)):K(this,b_).setAttributeNS(K(this,S_),K(this,x_),e):K(this,b_).setAttributeNS(K(this,S_),K(this,x_),K(this,C_,w_).toString()))}get booleanValue(){return K(this,b_).hasAttributeNS(K(this,S_),K(this,x_))}set booleanValue(e){if(!K(this,C_,w_)||K(this,C_,w_).length===1)this.value=e?``:null;else throw new DOMException(`Value is not fully templatized`)}};y_=new WeakMap,b_=new WeakMap,x_=new WeakMap,S_=new WeakMap,C_=new WeakSet,w_=function(){return L_.get(this)};var B_=class extends I_{constructor(e,t){super(),m_(this,T_,void 0),m_(this,E_,void 0),h_(this,T_,e),h_(this,E_,t?[...t]:[new Text])}get replacementNodes(){return K(this,E_)}get parentNode(){return K(this,T_)}get nextSibling(){return K(this,E_)[K(this,E_).length-1].nextSibling}get previousSibling(){return K(this,E_)[0].previousSibling}get value(){return K(this,E_).map(e=>e.textContent).join(``)}set value(e){this.replace(e)}replace(...e){let t=e.flat().flatMap(e=>e==null?[new Text]:e.forEach?[...e]:e.nodeType===F_?[...e.childNodes]:e.nodeType?[e]:[new Text(e)]);t.length||t.push(new Text),h_(this,E_,H_(K(this,E_)[0].parentNode,K(this,E_),t,this.nextSibling))}};T_=new WeakMap,E_=new WeakMap;var V_=class extends B_{constructor(e,t){let n=t.getAttribute(`directive`)||t.getAttribute(`type`),r=t.getAttribute(`expression`)||t.getAttribute(n)||``;r.startsWith(`{{`)&&(r=r.trim().slice(2,-2).trim()),super(e),this.expression=r,this.template=t,this.directive=n}};function H_(e,t,n,r=null){let i=0,a,o,s,c=n.length,l=t.length;for(;i<c&&i<l&&t[i]==n[i];)i++;for(;i<c&&i<l&&n[c-1]==t[l-1];)r=n[--l,--c];if(i==l)for(;i<c;)e.insertBefore(n[i++],r);if(i==c)for(;i<l;)e.removeChild(t[i++]);else{for(a=t[i];i<c;)s=n[i++],o=a?a.nextSibling:r,a==s?a=o:i<c&&n[i]==o?(e.replaceChild(s,a),a=o):e.insertBefore(s,a);for(;a!=r;)o=a.nextSibling,e.removeChild(a),a=o}return n}var U_={string:e=>String(e)},W_=class{constructor(e){this.template=e,this.state=void 0}},G_=new WeakMap,K_=new WeakMap,q_={partial:(e,t)=>{t[e.expression]=new W_(e.template)},if:(e,t)=>{var n;if(Q_(e.expression,t)){if(G_.get(e)!==e.template){G_.set(e,e.template);let n=new j_(e.template,t,Y_);e.replace(n),K_.set(e,n)}else(n=K_.get(e))==null||n.update(t)}else e.replace(``),G_.delete(e),K_.delete(e)}},J_=Object.keys(q_),Y_={processCallback(e,t,n){var r,i;if(n)for(let[e,a]of t){if(a instanceof V_){if(!a.directive){let e=J_.find(e=>a.template.hasAttribute(e));e&&(a.directive=e,a.expression=a.template.getAttribute(e))}(r=q_[a.directive])==null||r.call(q_,a,n);continue}let t=Q_(e,n);t instanceof W_?G_.get(a)===t.template?(i=K_.get(a))==null||i.update(t.state):(G_.set(a,t.template),t=new j_(t.template,t.state,Y_),a.value=t,K_.set(a,t)):t?(a instanceof z_&&a.attributeName.startsWith(`aria-`)&&(t=String(t)),a instanceof z_?typeof t==`boolean`?a.booleanValue=t:typeof t==`function`?a.element[a.attributeName]=t:a.value=t:(a.value=t,G_.delete(a),K_.delete(a))):a instanceof z_?a.value=void 0:(a.value=void 0,G_.delete(a),K_.delete(a))}}},X_={"!":e=>!e,"!!":e=>!!e,"==":(e,t)=>e==t,"!=":(e,t)=>e!=t,">":(e,t)=>e>t,">=":(e,t)=>e>=t,"<":(e,t)=>e<t,"<=":(e,t)=>e<=t,"??":(e,t)=>e??t,"|":(e,t)=>U_[t]?.call(U_,e)};function Z_(e){return nv(e,{boolean:/true|false/,number:/-?\d+\.?\d*/,string:/(["'])((?:\\.|[^\\])*?)\1/,operator:/[!=><][=!]?|\?\?|\|/,ws:/\s+/,param:/[$a-z_][$\w]*/i}).filter(({type:e})=>e!==`ws`)}function Q_(e,t={}){let n=Z_(e);if(n.length===0||n.some(({type:e})=>!e))return $_(e);if(n[0]?.token===`>`){let r=t[n[1]?.token];if(!r)return $_(e);let i={...t};r.state=i;let a=n.slice(2);for(let e=0;e<a.length;e+=3){let n=a[e]?.token,r=a[e+1]?.token,o=a[e+2]?.token;n&&r===`=`&&(i[n]=tv(o,t))}return r}if(n.length===1)return ev(n[0])?tv(n[0].token,t):$_(e);if(n.length===2){let r=X_[n[0]?.token];return!r||!ev(n[1])?$_(e):r(tv(n[1].token,t))}if(n.length===3){let r=n[1]?.token,i=X_[r];if(!i||!ev(n[0])||!ev(n[2]))return $_(e);let a=tv(n[0].token,t);return r===`|`?i(a,n[2].token):i(a,tv(n[2].token,t))}}function $_(e){return console.warn(`Warning: invalid expression \`${e}\``),!1}function ev({type:e}){return[`number`,`boolean`,`string`,`param`].includes(e)}function tv(e,t){let n=e[0],r=e.slice(-1);return e===`true`||e===`false`?e===`true`:n===r&&[`'`,`"`].includes(n)?e.slice(1,-1):Bs(e)?parseFloat(e):t[e]}function nv(e,t){let n,r,i,a=[];for(;e;){i=null,n=e.length;for(let a in t)r=t[a].exec(e),r&&r.index<n&&(i={token:r[0],type:a,matches:r.slice(1)},n=r.index);n&&a.push({token:e.substr(0,n),type:void 0}),i&&a.push(i),e=e.substr(n+(i?i.token.length:0))}return a}var rv=(e,t,n)=>{if(!t.has(e))throw TypeError(`Cannot `+n)},iv=(e,t,n)=>(rv(e,t,`read from private field`),n?n.call(e):t.get(e)),av=(e,t,n)=>{if(t.has(e))throw TypeError(`Cannot add the same private member more than once`);t instanceof WeakSet?t.add(e):t.set(e,n)},ov=(e,t,n,r)=>(rv(e,t,`write to private field`),r?r.call(e,n):t.set(e,n),n),sv=(e,t,n)=>(rv(e,t,`access private method`),n),cv,lv,uv,dv,fv,pv,mv,hv,gv,_v={mediatargetlivewindow:`targetlivewindow`,mediastreamtype:`streamtype`},vv=sc.createElement(`template`);vv.innerHTML=`
  <style>
    :host {
      display: inline-block;
      line-height: 0;
    }

    media-controller {
      width: 100%;
      height: 100%;
    }

    media-captions-button:not([mediasubtitleslist]),
    media-captions-menu:not([mediasubtitleslist]),
    media-captions-menu-button:not([mediasubtitleslist]),
    media-audio-track-menu[mediaaudiotrackunavailable],
    media-audio-track-menu-button[mediaaudiotrackunavailable],
    media-rendition-menu[mediarenditionunavailable],
    media-rendition-menu-button[mediarenditionunavailable],
    media-volume-range[mediavolumeunavailable],
    media-airplay-button[mediaairplayunavailable],
    media-fullscreen-button[mediafullscreenunavailable],
    media-cast-button[mediacastunavailable],
    media-pip-button[mediapipunavailable] {
      display: none;
    }
  </style>
`;var yv=class extends N.HTMLElement{constructor(){super(),av(this,fv),av(this,mv),av(this,cv,void 0),av(this,lv,void 0),av(this,uv,void 0),av(this,dv,void 0),av(this,gv,void 0),this.shadowRoot?this.renderRoot=this.shadowRoot:(this.renderRoot=this.attachShadow({mode:`open`}),this.createRenderer()),ov(this,dv,new MutationObserver(e=>{(!this.mediaController||this.mediaController?.breakpointsComputed)&&e.some(e=>{let t=e.target;return t===this||t.localName===`media-controller`&&!!(_v[e.attributeName]||e.attributeName.startsWith(`breakpoint`))})&&this.render()})),ov(this,gv,this.render.bind(this)),sv(this,fv,pv).call(this,`template`)}get mediaController(){return this.renderRoot.querySelector(`media-controller`)}get template(){return iv(this,cv)??this.constructor.template}set template(e){e===null?this.removeAttribute(`template`):typeof e==`string`?this.setAttribute(`template`,e):e instanceof HTMLTemplateElement&&(ov(this,cv,e),ov(this,uv,null),this.createRenderer())}get props(){let e=[...Array.from(this.mediaController?.attributes??[]).filter(({name:e})=>_v[e]||e.startsWith(`breakpoint`)),...Array.from(this.attributes)],t={};for(let n of e){let e=_v[n.name]??Rs(n.name),{value:r}=n;r==null?t[e]=!1:(Bs(r)&&(r=parseFloat(r)),t[e]=r===``||r)}return t}attributeChangedCallback(e,t,n){e===`template`&&t!=n&&sv(this,mv,hv).call(this)}connectedCallback(){this.addEventListener(Ss.BREAKPOINTS_COMPUTED,iv(this,gv)),iv(this,dv).observe(this,{attributes:!0}),iv(this,dv).observe(this.renderRoot,{attributes:!0,subtree:!0}),sv(this,mv,hv).call(this)}disconnectedCallback(){this.removeEventListener(Ss.BREAKPOINTS_COMPUTED,iv(this,gv)),iv(this,dv).disconnect()}createRenderer(){this.template instanceof HTMLTemplateElement&&this.template!==iv(this,lv)&&(ov(this,lv,this.template),this.renderer=new j_(this.template,this.props,this.constructor.processor),this.renderRoot.textContent=``,this.renderRoot.append(vv.content.cloneNode(!0),this.renderer))}render(){var e;(e=this.renderer)==null||e.update(this.props)}};cv=new WeakMap,lv=new WeakMap,uv=new WeakMap,dv=new WeakMap,fv=new WeakSet,pv=function(e){if(Object.prototype.hasOwnProperty.call(this,e)){let t=this[e];delete this[e],this[e]=t}},mv=new WeakSet,hv=function(){let e=this.getAttribute(`template`);if(!e||e===iv(this,uv))return;let t=this.getRootNode(),n=(t?.getElementById)?.call(t,e);n?(ov(this,uv,e),ov(this,cv,n),this.createRenderer()):bv(e)&&(ov(this,uv,e),xv(e).then(e=>{let t=sc.createElement(`template`);t.innerHTML=e,ov(this,cv,t),this.createRenderer()}).catch(console.error))},gv=new WeakMap,yv.observedAttributes=[`template`],yv.processor=Y_;function bv(e){if(!/^(\/|\.\/|https?:\/\/)/.test(e))return!1;let t=/^https?:\/\//.test(e)?void 0:location.origin;try{new URL(e,t)}catch{return!1}return!0}async function xv(e){let t=await fetch(e);if(t.status!==200)throw Error(`Failed to load resource: the server responded with a status of ${t.status}`);return t.text()}N.customElements.get(`media-theme`)||N.customElements.define(`media-theme`,yv);function Sv({anchor:e,floating:t,placement:n}){let{x:r,y:i}=Tv(Cv({anchor:e,floating:t}),n);return{x:r,y:i}}function Cv({anchor:e,floating:t}){return{anchor:wv(e,t.offsetParent),floating:{x:0,y:0,width:t.offsetWidth,height:t.offsetHeight}}}function wv(e,t){let n=e.getBoundingClientRect(),r=t?.getBoundingClientRect()??{x:0,y:0};return{x:n.x-r.x,y:n.y-r.y,width:n.width,height:n.height}}function Tv({anchor:e,floating:t},n){let r=Dv(n)===`x`?`y`:`x`,i=r===`y`?`height`:`width`,a=Ev(n),o=e.x+e.width/2-t.width/2,s=e.y+e.height/2-t.height/2,c=e[i]/2-t[i]/2,l;switch(a){case`top`:l={x:o,y:e.y-t.height};break;case`bottom`:l={x:o,y:e.y+e.height};break;case`right`:l={x:e.x+e.width,y:s};break;case`left`:l={x:e.x-t.width,y:s};break;default:l={x:e.x,y:e.y}}switch(n.split(`-`)[1]){case`start`:l[r]-=c;break;case`end`:l[r]+=c}return l}function Ev(e){return e.split(`-`)[0]}function Dv(e){return[`top`,`bottom`].includes(Ev(e))?`y`:`x`}var Ov=class extends Event{constructor({action:e=`auto`,relatedTarget:t,...n}){super(`invoke`,n),this.action=e,this.relatedTarget=t}},kv=class extends Event{constructor({newState:e,oldState:t,...n}){super(`toggle`,n),this.newState=e,this.oldState=t}},Av=(e,t,n)=>{if(!t.has(e))throw TypeError(`Cannot `+n)},q=(e,t,n)=>(Av(e,t,`read from private field`),n?n.call(e):t.get(e)),J=(e,t,n)=>{if(t.has(e))throw TypeError(`Cannot add the same private member more than once`);t instanceof WeakSet?t.add(e):t.set(e,n)},jv=(e,t,n,r)=>(Av(e,t,`write to private field`),r?r.call(e,n):t.set(e,n),n),Y=(e,t,n)=>(Av(e,t,`access private method`),n),Mv,Nv,Pv,Fv,Iv,Lv,Rv,zv,Bv,Vv,Hv,Uv,Wv,Gv,Kv,qv,Jv,Yv,Xv,Zv,Qv,$v,ey,ty,ny,ry,iy,ay,oy,sy,cy,ly,uy,dy,fy,py,my,hy,gy,_y,vy,yy,by,xy,Sy,Cy;function wy({type:e,text:t,value:n,checked:r}){let i=sc.createElement(`media-chrome-menu-item`);i.type=e??``,i.part.add(`menu-item`),e&&i.part.add(e),i.value=n,i.checked=r;let a=sc.createElement(`span`);return a.textContent=t,i.append(a),i}function Ty(e,t){let n=e.querySelector(`:scope > [slot="${t}"]`);if(n?.nodeName==`SLOT`&&(n=n.assignedElements({flatten:!0})[0]),n)return n=n.cloneNode(!0),n;let r=e.shadowRoot.querySelector(`[name="${t}"] > svg`);return r?r.cloneNode(!0):``}function Ey(e){return`
    <style>
      :host {
        font: var(--media-font,
          var(--media-font-weight, normal)
          var(--media-font-size, 14px) /
          var(--media-text-content-height, var(--media-control-height, 24px))
          var(--media-font-family, helvetica neue, segoe ui, roboto, arial, sans-serif));
        color: var(--media-text-color, var(--media-primary-color, rgb(238 238 238)));
        --_menu-bg: rgb(20 20 30 / .8);
        background: var(--media-menu-background, var(--media-control-background, var(--media-secondary-color, var(--_menu-bg))));
        border-radius: var(--media-menu-border-radius);
        border: var(--media-menu-border, none);
        display: var(--media-menu-display, inline-flex) !important;
        
        transition: var(--media-menu-transition-in,
          visibility 0s,
          opacity .2s ease-out,
          transform .15s ease-out,
          left .2s ease-in-out,
          min-width .2s ease-in-out,
          min-height .2s ease-in-out
        ) !important;
        
        visibility: var(--media-menu-visibility, visible);
        opacity: var(--media-menu-opacity, 1);
        max-height: var(--media-menu-max-height, var(--_menu-max-height, 300px));
        transform: var(--media-menu-transform-in, translateY(0) scale(1));
        flex-direction: column;
        
        min-height: 0;
        position: relative;
        bottom: var(--_menu-bottom);
        box-sizing: border-box;
      } 

      @-moz-document url-prefix() {
        :host{
          --_menu-bg: rgb(20 20 30);
        }
      }

      :host([hidden]) {
        transition: var(--media-menu-transition-out,
          visibility .15s ease-in,
          opacity .15s ease-in,
          transform .15s ease-in
        ) !important;
        visibility: var(--media-menu-hidden-visibility, hidden);
        opacity: var(--media-menu-hidden-opacity, 0);
        max-height: var(--media-menu-hidden-max-height,
          var(--media-menu-max-height, var(--_menu-max-height, 300px)));
        transform: var(--media-menu-transform-out, translateY(2px) scale(.99));
        pointer-events: none;
      }

      :host([slot="submenu"]) {
        background: none;
        width: 100%;
        min-height: 100%;
        position: absolute;
        bottom: 0;
        right: -100%;
      }

      #container {
        display: flex;
        flex-direction: column;
        min-height: 0;
        transition: transform .2s ease-out;
        transform: translate(0, 0);
      }

      #container.has-expanded {
        transition: transform .2s ease-in;
        transform: translate(-100%, 0);
      }

      button {
        background: none;
        color: inherit;
        border: none;
        padding: 0;
        font: inherit;
        outline: inherit;
        display: inline-flex;
        align-items: center;
      }

      slot[name="header"][hidden] {
        display: none;
      }

      slot[name="header"] > *,
      slot[name="header"]::slotted(*) {
        padding: .4em .7em;
        border-bottom: 1px solid rgb(255 255 255 / .25);
        cursor: var(--media-cursor, default);
      }

      slot[name="header"] > button[part~="back"],
      slot[name="header"]::slotted(button[part~="back"]) {
        cursor: var(--media-cursor, pointer);
      }

      svg[part~="back"] {
        height: var(--media-menu-icon-height, var(--media-control-height, 24px));
        fill: var(--media-icon-color, var(--media-primary-color, rgb(238 238 238)));
        display: block;
        margin-right: .5ch;
      }

      slot:not([name]) {
        gap: var(--media-menu-gap);
        flex-direction: var(--media-menu-flex-direction, column);
        overflow: var(--media-menu-overflow, hidden auto);
        display: flex;
        min-height: 0;
      }

      :host([role="menu"]) slot:not([name]) {
        padding-block: .4em;
      }

      slot:not([name])::slotted([role="menu"]) {
        background: none;
      }

      media-chrome-menu-item > span {
        margin-right: .5ch;
        max-width: var(--media-menu-item-max-width);
        text-overflow: ellipsis;
        overflow: hidden;
      }
    </style>
    <style id="layout-row" media="width:0">

      slot[name="header"] > *,
      slot[name="header"]::slotted(*) {
        padding: .4em .5em;
      }

      slot:not([name]) {
        gap: var(--media-menu-gap, .25em);
        flex-direction: var(--media-menu-flex-direction, row);
        padding-inline: .5em;
      }

      media-chrome-menu-item {
        padding: .3em .5em;
      }

      media-chrome-menu-item[aria-checked="true"] {
        background: var(--media-menu-item-checked-background, rgb(255 255 255 / .2));
      }

      
      media-chrome-menu-item::part(checked-indicator) {
        display: var(--media-menu-item-checked-indicator-display, none);
      }
    </style>
    <div id="container" part="container">
      <slot name="header" hidden>
        <button part="back button" aria-label="Back to previous menu">
          <slot name="back-icon">
            <svg aria-hidden="true" viewBox="0 0 20 24" part="back indicator">
              <path d="m11.88 17.585.742-.669-4.2-4.665 4.2-4.666-.743-.669-4.803 5.335 4.803 5.334Z"/>
            </svg>
          </slot>
          <slot name="title"></slot>
        </button>
      </slot>
      <slot></slot>
    </div>
    <slot name="checked-indicator" hidden></slot>
  `}var Dy={STYLE:`style`,HIDDEN:`hidden`,DISABLED:`disabled`,ANCHOR:`anchor`},Oy=class extends N.HTMLElement{constructor(){if(super(),J(this,zv),J(this,Vv),J(this,Wv),J(this,Kv),J(this,Jv),J(this,Xv),J(this,ey),J(this,ny),J(this,iy),J(this,oy),J(this,cy),J(this,uy),J(this,fy),J(this,my),J(this,gy),J(this,vy),J(this,by),J(this,Sy),J(this,Mv,null),J(this,Nv,null),J(this,Pv,null),J(this,Fv,new Set),J(this,Iv,void 0),J(this,Lv,!1),J(this,Rv,null),J(this,Uv,()=>{let e=q(this,Fv),t=new Set(this.items);for(let n of e)t.has(n)||this.dispatchEvent(new CustomEvent(`removemenuitem`,{detail:n}));for(let n of t)e.has(n)||this.dispatchEvent(new CustomEvent(`addmenuitem`,{detail:n}));jv(this,Fv,t)}),J(this,Qv,()=>{Y(this,ey,ty).call(this),Y(this,ny,ry).call(this,!1)}),J(this,$v,()=>{Y(this,ey,ty).call(this)}),!this.shadowRoot){this.attachShadow(this.constructor.shadowRootOptions);let e=pc(this.attributes);this.shadowRoot.innerHTML=this.constructor.getTemplateHTML(e)}this.container=this.shadowRoot.querySelector(`#container`),this.defaultSlot=this.shadowRoot.querySelector(`slot:not([name])`),jv(this,Iv,new MutationObserver(q(this,Uv)))}static get observedAttributes(){return[Dy.DISABLED,Dy.HIDDEN,Dy.STYLE,Dy.ANCHOR,A.MEDIA_CONTROLLER]}static formatMenuItemText(e,t){return e}enable(){this.addEventListener(`click`,this),this.addEventListener(`focusout`,this),this.addEventListener(`keydown`,this),this.addEventListener(`invoke`,this),this.addEventListener(`toggle`,this)}disable(){this.removeEventListener(`click`,this),this.removeEventListener(`focusout`,this),this.removeEventListener(`keyup`,this),this.removeEventListener(`invoke`,this),this.removeEventListener(`toggle`,this)}handleEvent(e){switch(e.type){case`slotchange`:Y(this,zv,Bv).call(this,e);break;case`invoke`:Y(this,Kv,qv).call(this,e);break;case`click`:Y(this,iy,ay).call(this,e);break;case`toggle`:Y(this,cy,ly).call(this,e);break;case`focusout`:Y(this,fy,py).call(this,e);break;case`keydown`:Y(this,my,hy).call(this,e)}}connectedCallback(){var e,t;q(this,Iv).observe(this.defaultSlot,{childList:!0}),jv(this,Rv,Dc(this.shadowRoot,`:host`)),Y(this,Wv,Gv).call(this),this.hasAttribute(`disabled`)||this.enable(),this.role||=`menu`,jv(this,Mv,hc(this)),(t=(e=q(this,Mv))?.associateElement)==null||t.call(e,this),this.hidden||(dc(Ay(this),q(this,Qv)),dc(this,q(this,$v))),Y(this,Vv,Hv).call(this),this.shadowRoot.addEventListener(`slotchange`,this)}disconnectedCallback(){var e,t;q(this,Iv).disconnect(),fc(Ay(this),q(this,Qv)),fc(this,q(this,$v)),this.disable(),(t=(e=q(this,Mv))?.unassociateElement)==null||t.call(e,this),jv(this,Mv,null),jv(this,Nv,null),jv(this,Pv,null),this.shadowRoot.removeEventListener(`slotchange`,this)}attributeChangedCallback(e,t,n){var r,i,a,o;e===Dy.HIDDEN&&n!==t?(q(this,Lv)||jv(this,Lv,!0),this.hidden?Y(this,Xv,Zv).call(this):Y(this,Jv,Yv).call(this),this.dispatchEvent(new kv({oldState:this.hidden?`open`:`closed`,newState:this.hidden?`closed`:`open`,bubbles:!0}))):e===A.MEDIA_CONTROLLER?(t&&((i=(r=q(this,Mv))?.unassociateElement)==null||i.call(r,this),jv(this,Mv,null)),n&&this.isConnected&&(jv(this,Mv,hc(this)),(o=(a=q(this,Mv))?.associateElement)==null||o.call(a,this))):e===Dy.DISABLED&&n!==t?n==null?this.enable():this.disable():e===Dy.STYLE&&n!==t&&Y(this,Wv,Gv).call(this)}formatMenuItemText(e,t){return this.constructor.formatMenuItemText(e,t)}get anchor(){return this.getAttribute(`anchor`)}set anchor(e){this.setAttribute(`anchor`,`${e}`)}get anchorElement(){return this.anchor?Sc(this)?.querySelector(`#${this.anchor}`):null}get items(){return this.defaultSlot.assignedElements({flatten:!0}).filter(ky)}get radioGroupItems(){return this.items.filter(e=>e.role===`menuitemradio`)}get checkedItems(){return this.items.filter(e=>e.checked)}get value(){return this.checkedItems[0]?.value??``}set value(e){let t=this.items.find(t=>t.value===e);t&&Y(this,Sy,Cy).call(this,t)}focus(){jv(this,Nv,xc()),this.items.length?(Y(this,by,xy).call(this,this.items[0]),this.items[0].focus()):this.querySelector(`[autofocus], [tabindex]:not([tabindex="-1"]), [role="menu"]`)?.focus()}handleSelect(e){var t;let n=Y(this,gy,_y).call(this,e);n&&(Y(this,Sy,Cy).call(this,n,n.type===`checkbox`),q(this,Pv)&&!this.hidden&&((t=q(this,Nv))==null||t.focus(),this.hidden=!0))}get keysUsed(){return[`Enter`,`Escape`,`Tab`,` `,`ArrowDown`,`ArrowUp`,`Home`,`End`]}handleMove(e){let{key:t}=e,n=this.items,r=Y(this,gy,_y).call(this,e)??Y(this,vy,yy).call(this)??n[0],i=n.indexOf(r),a=Math.max(0,i);t===`ArrowDown`?a++:t===`ArrowUp`?a--:e.key===`Home`?a=0:e.key===`End`&&(a=n.length-1),a<0&&(a=n.length-1),a>n.length-1&&(a=0),Y(this,by,xy).call(this,n[a]),n[a].focus()}};Mv=new WeakMap,Nv=new WeakMap,Pv=new WeakMap,Fv=new WeakMap,Iv=new WeakMap,Lv=new WeakMap,Rv=new WeakMap,zv=new WeakSet,Bv=function(e){let t=e.target;for(let e of t.assignedNodes({flatten:!0}))e.nodeType===3&&e.textContent.trim()===``&&e.remove();[`header`,`title`].includes(t.name)&&Y(this,Vv,Hv).call(this),t.name||q(this,Uv).call(this)},Vv=new WeakSet,Hv=function(){let e=this.shadowRoot.querySelector(`slot[name="header"]`);e.hidden=this.shadowRoot.querySelector(`slot[name="title"]`).assignedNodes().length===0&&e.assignedNodes().length===0},Uv=new WeakMap,Wv=new WeakSet,Gv=function(){let e=this.shadowRoot.querySelector(`#layout-row`),t=getComputedStyle(this).getPropertyValue(`--media-menu-layout`)?.trim();e.setAttribute(`media`,t===`row`?``:`width:0`)},Kv=new WeakSet,qv=function(e){jv(this,Pv,e.relatedTarget),yc(this,e.relatedTarget)||(this.hidden=!this.hidden)},Jv=new WeakSet,Yv=function(){var e;(e=q(this,Pv))==null||e.setAttribute(`aria-expanded`,`true`),this.addEventListener(`transitionend`,()=>this.focus(),{once:!0}),dc(Ay(this),q(this,Qv)),dc(this,q(this,$v))},Xv=new WeakSet,Zv=function(){var e;(e=q(this,Pv))==null||e.setAttribute(`aria-expanded`,`false`),fc(Ay(this),q(this,Qv)),fc(this,q(this,$v))},Qv=new WeakMap,$v=new WeakMap,ey=new WeakSet,ty=function(e){if(this.hasAttribute(`mediacontroller`)&&!this.anchor||this.hidden||!this.anchorElement)return;let{x:t,y:n}=Sv({anchor:this.anchorElement,floating:this,placement:`top-start`});e??=this.offsetWidth;let r=Ay(this).getBoundingClientRect(),i=r.width-t-e,a=r.height-n-this.offsetHeight,{style:o}=q(this,Rv);o.setProperty(`position`,`absolute`),o.setProperty(`right`,`${Math.max(0,i)}px`),o.setProperty(`--_menu-bottom`,`${a}px`);let s=getComputedStyle(this),c=o.getPropertyValue(`--_menu-bottom`)===s.bottom?a:parseFloat(s.bottom),l=r.height-c-parseFloat(s.marginBottom);this.style.setProperty(`--_menu-max-height`,`${l}px`)},ny=new WeakSet,ry=function(e){let t=this.querySelector(`[role="menuitem"][aria-haspopup][aria-expanded="true"]`),n=t?.querySelector(`[role="menu"]`),{style:r}=q(this,Rv);if(e||r.setProperty(`--media-menu-transition-in`,`none`),n){let e=n.offsetHeight,r=Math.max(n.offsetWidth,t.offsetWidth);this.style.setProperty(`min-width`,`${r}px`),this.style.setProperty(`min-height`,`${e}px`),Y(this,ey,ty).call(this,r)}else this.style.removeProperty(`min-width`),this.style.removeProperty(`min-height`),Y(this,ey,ty).call(this);r.removeProperty(`--media-menu-transition-in`)},iy=new WeakSet,ay=function(e){var t;if(e.stopPropagation(),e.composedPath().includes(q(this,oy,sy))){(t=q(this,Nv))==null||t.focus(),this.hidden=!0;return}let n=Y(this,gy,_y).call(this,e);n&&!n.hasAttribute(`disabled`)&&(Y(this,by,xy).call(this,n),this.handleSelect(e))},oy=new WeakSet,sy=function(){return this.shadowRoot.querySelector(`slot[name="header"]`).assignedElements({flatten:!0})?.find(e=>e.matches(`button[part~="back"]`))},cy=new WeakSet,ly=function(e){if(e.target===this)return;Y(this,uy,dy).call(this);let t=Array.from(this.querySelectorAll(`[role="menuitem"][aria-haspopup]`));for(let n of t)n.invokeTargetElement!=e.target&&e.newState==`open`&&n.getAttribute(`aria-expanded`)==`true`&&!n.invokeTargetElement.hidden&&n.invokeTargetElement.dispatchEvent(new Ov({relatedTarget:n}));for(let e of t)e.setAttribute(`aria-expanded`,`${!e.submenuElement.hidden}`);Y(this,ny,ry).call(this,!0)},uy=new WeakSet,dy=function(){let e=this.querySelector(`[role="menuitem"] > [role="menu"]:not([hidden])`);this.container.classList.toggle(`has-expanded`,!!e)},fy=new WeakSet,py=function(e){var t;yc(this,e.relatedTarget)||(q(this,Lv)&&((t=q(this,Nv))==null||t.focus()),q(this,Pv)&&q(this,Pv)!==e.relatedTarget&&!this.hidden&&(this.hidden=!0))},my=new WeakSet,hy=function(e){var t,n,r,i,a;let{key:o,ctrlKey:s,altKey:c,metaKey:l}=e;if(!(s||c||l)&&this.keysUsed.includes(o)){if(e.preventDefault(),e.stopPropagation(),o===`Tab`){if(q(this,Lv)){this.hidden=!0;return}e.shiftKey?(n=(t=this.previousElementSibling)?.focus)==null||n.call(t):(i=(r=this.nextElementSibling)?.focus)==null||i.call(r),this.blur()}else o===`Escape`?((a=q(this,Nv))==null||a.focus(),q(this,Lv)&&(this.hidden=!0)):o===`Enter`||o===` `?this.handleSelect(e):this.handleMove(e)}},gy=new WeakSet,_y=function(e){return e.composedPath().find(e=>[`menuitemradio`,`menuitemcheckbox`].includes(e.role))},vy=new WeakSet,yy=function(){return this.items.find(e=>e.tabIndex===0)},by=new WeakSet,xy=function(e){for(let t of this.items)t.tabIndex=t===e?0:-1},Sy=new WeakSet,Cy=function(e,t){let n=[...this.checkedItems];e.type===`radio`&&this.radioGroupItems.forEach(e=>e.checked=!1),e.checked=!t||!e.checked,this.checkedItems.some((e,t)=>e!=n[t])&&this.dispatchEvent(new Event(`change`,{bubbles:!0,composed:!0}))},Oy.shadowRootOptions={mode:`open`},Oy.getTemplateHTML=Ey;function ky(e){return[`menuitem`,`menuitemradio`,`menuitemcheckbox`].includes(e?.role)}function Ay(e){return(e.getAttribute(`bounds`)?bc(e,`#${e.getAttribute(`bounds`)}`):mc(e)||e.parentElement)??e}N.customElements.get(`media-chrome-menu`)||N.customElements.define(`media-chrome-menu`,Oy);var jy=(e,t,n)=>{if(!t.has(e))throw TypeError(`Cannot `+n)},My=(e,t,n)=>(jy(e,t,`read from private field`),n?n.call(e):t.get(e)),Ny=(e,t,n)=>{if(t.has(e))throw TypeError(`Cannot add the same private member more than once`);t instanceof WeakSet?t.add(e):t.set(e,n)},Py=(e,t,n,r)=>(jy(e,t,`write to private field`),r?r.call(e,n):t.set(e,n),n),Fy=(e,t,n)=>(jy(e,t,`access private method`),n),Iy,Ly,Ry,zy,By,Vy,Hy,Uy,Wy,Gy,Ky,qy,Jy;function Yy(e){return`
    <style>
      :host {
        transition: var(--media-menu-item-transition,
          background .15s linear,
          opacity .2s ease-in-out
        );
        outline: var(--media-menu-item-outline, 0);
        outline-offset: var(--media-menu-item-outline-offset, -1px);
        cursor: var(--media-cursor, pointer);
        display: flex;
        align-items: center;
        align-self: stretch;
        justify-self: stretch;
        white-space: nowrap;
        white-space-collapse: collapse;
        text-wrap: nowrap;
        padding: .4em .8em .4em 1em;
      }

      :host(:focus-visible) {
        box-shadow: var(--media-menu-item-focus-shadow, inset 0 0 0 2px rgb(27 127 204 / .9));
        outline: var(--media-menu-item-hover-outline, 0);
        outline-offset: var(--media-menu-item-hover-outline-offset,  var(--media-menu-item-outline-offset, -1px));
      }

      :host(:hover) {
        cursor: var(--media-cursor, pointer);
        background: var(--media-menu-item-hover-background, rgb(92 92 102 / .5));
        outline: var(--media-menu-item-hover-outline);
        outline-offset: var(--media-menu-item-hover-outline-offset,  var(--media-menu-item-outline-offset, -1px));
      }

      :host([aria-checked="true"]) {
        background: var(--media-menu-item-checked-background);
      }

      :host([hidden]) {
        display: none;
      }

      :host([disabled]) {
        pointer-events: none;
        color: rgba(255, 255, 255, .3);
      }

      slot:not([name]) {
        width: 100%;
      }

      slot:not([name="submenu"]) {
        display: inline-flex;
        align-items: center;
        transition: inherit;
        opacity: var(--media-menu-item-opacity, 1);
      }

      slot[name="description"] {
        justify-content: end;
      }

      slot[name="description"] > span {
        display: inline-block;
        margin-inline: 1em .2em;
        max-width: var(--media-menu-item-description-max-width, 100px);
        text-overflow: ellipsis;
        overflow: hidden;
        font-size: .8em;
        font-weight: 400;
        text-align: right;
        position: relative;
        top: .04em;
      }

      slot[name="checked-indicator"] {
        display: none;
      }

      :host(:is([role="menuitemradio"],[role="menuitemcheckbox"])) slot[name="checked-indicator"] {
        display: var(--media-menu-item-checked-indicator-display, inline-block);
      }

      
      svg, img, ::slotted(svg), ::slotted(img) {
        height: var(--media-menu-item-icon-height, var(--media-control-height, 24px));
        fill: var(--media-icon-color, var(--media-primary-color, rgb(238 238 238)));
        display: block;
      }

      
      [part~="indicator"],
      ::slotted([part~="indicator"]) {
        fill: var(--media-menu-item-indicator-fill,
          var(--media-icon-color, var(--media-primary-color, rgb(238 238 238))));
        height: var(--media-menu-item-indicator-height, 1.25em);
        margin-right: .5ch;
      }

      [part~="checked-indicator"] {
        visibility: hidden;
      }

      :host([aria-checked="true"]) [part~="checked-indicator"] {
        visibility: visible;
      }
    </style>
    <slot name="checked-indicator">
      <svg aria-hidden="true" viewBox="0 1 24 24" part="checked-indicator indicator">
        <path d="m10 15.17 9.193-9.191 1.414 1.414-10.606 10.606-6.364-6.364 1.414-1.414 4.95 4.95Z"/>
      </svg>
    </slot>
    <slot name="prefix"></slot>
    <slot></slot>
    <slot name="description"></slot>
    <slot name="suffix">
      ${this.getSuffixSlotInnerHTML(e)}
    </slot>
    <slot name="submenu"></slot>
  `}function Xy(e){return``}var Zy={TYPE:`type`,VALUE:`value`,CHECKED:`checked`,DISABLED:`disabled`},Qy=class extends N.HTMLElement{constructor(){if(super(),Ny(this,Ry),Ny(this,By),Ny(this,Hy),Ny(this,qy),Ny(this,Iy,!1),Ny(this,Ly,void 0),Ny(this,Wy,()=>{this.submenuElement.items&&this.setAttribute(`submenusize`,`${this.submenuElement.items.length}`);let e=this.shadowRoot.querySelector(`slot[name="description"]`),t=this.submenuElement.checkedItems?.[0],n=t?.dataset.description??t?.text,r=sc.createElement(`span`);r.textContent=n??``,e.replaceChildren(r)}),Ny(this,Gy,e=>{let{key:t}=e;this.keysUsed.includes(t)?this.handleClick(e):this.removeEventListener(`keyup`,My(this,Gy))}),Ny(this,Ky,e=>{let{metaKey:t,altKey:n,key:r}=e;t||n||!this.keysUsed.includes(r)?this.removeEventListener(`keyup`,My(this,Gy)):this.addEventListener(`keyup`,My(this,Gy),{once:!0})}),!this.shadowRoot){this.attachShadow(this.constructor.shadowRootOptions);let e=pc(this.attributes);this.shadowRoot.innerHTML=this.constructor.getTemplateHTML(e)}}static get observedAttributes(){return[Zy.TYPE,Zy.DISABLED,Zy.CHECKED,Zy.VALUE]}enable(){this.hasAttribute(`tabindex`)||this.setAttribute(`tabindex`,`-1`),$y(this)&&!this.hasAttribute(`aria-checked`)&&this.setAttribute(`aria-checked`,`false`),this.addEventListener(`click`,this),this.addEventListener(`keydown`,this)}disable(){this.removeAttribute(`tabindex`),this.removeEventListener(`click`,this),this.removeEventListener(`keydown`,this),this.removeEventListener(`keyup`,this)}handleEvent(e){switch(e.type){case`slotchange`:Fy(this,Ry,zy).call(this,e);break;case`click`:this.handleClick(e);break;case`keydown`:My(this,Ky).call(this,e);break;case`keyup`:My(this,Gy).call(this,e)}}attributeChangedCallback(e,t,n){e===Zy.CHECKED&&$y(this)&&!My(this,Iy)?this.setAttribute(`aria-checked`,n==null?`false`:`true`):e===Zy.TYPE&&n!==t?this.role=`menuitem`+n:e===Zy.DISABLED&&n!==t&&(n==null?this.enable():this.disable())}connectedCallback(){this.hasAttribute(Zy.DISABLED)||this.enable(),this.role=`menuitem`+this.type,Py(this,Ly,eb(this,this.parentNode)),Fy(this,qy,Jy).call(this),this.submenuElement&&Fy(this,By,Vy).call(this),this.shadowRoot.addEventListener(`slotchange`,this)}disconnectedCallback(){this.disable(),Fy(this,qy,Jy).call(this),Py(this,Ly,null),this.shadowRoot.removeEventListener(`slotchange`,this)}get invokeTarget(){return this.getAttribute(`invoketarget`)}set invokeTarget(e){this.setAttribute(`invoketarget`,`${e}`)}get invokeTargetElement(){return this.invokeTarget?Sc(this)?.querySelector(`#${this.invokeTarget}`):this.submenuElement}get submenuElement(){return this.shadowRoot.querySelector(`slot[name="submenu"]`).assignedElements({flatten:!0})[0]}get type(){return this.getAttribute(Zy.TYPE)??``}set type(e){this.setAttribute(Zy.TYPE,`${e}`)}get value(){return this.getAttribute(Zy.VALUE)??this.text}set value(e){this.setAttribute(Zy.VALUE,e)}get text(){return(this.textContent??``).trim()}get checked(){if($y(this))return this.getAttribute(`aria-checked`)===`true`}set checked(e){$y(this)&&(Py(this,Iy,!0),this.setAttribute(`aria-checked`,e?`true`:`false`),e?this.part.add(`checked`):this.part.remove(`checked`))}handleClick(e){$y(this)||this.invokeTargetElement&&yc(this,e.target)&&this.invokeTargetElement.dispatchEvent(new Ov({relatedTarget:this}))}get keysUsed(){return[`Enter`,` `]}};Iy=new WeakMap,Ly=new WeakMap,Ry=new WeakSet,zy=function(e){let t=e.target;if(!t?.name)for(let e of t.assignedNodes({flatten:!0}))e instanceof Text&&e.textContent.trim()===``&&e.remove();t.name===`submenu`&&(this.submenuElement?Fy(this,By,Vy).call(this):Fy(this,Hy,Uy).call(this))},By=new WeakSet,Vy=async function(){this.setAttribute(`aria-haspopup`,`menu`),this.setAttribute(`aria-expanded`,`${!this.submenuElement.hidden}`),this.submenuElement.addEventListener(`change`,My(this,Wy)),this.submenuElement.addEventListener(`addmenuitem`,My(this,Wy)),this.submenuElement.addEventListener(`removemenuitem`,My(this,Wy)),My(this,Wy).call(this)},Hy=new WeakSet,Uy=function(){this.removeAttribute(`aria-haspopup`),this.removeAttribute(`aria-expanded`),this.submenuElement.removeEventListener(`change`,My(this,Wy)),this.submenuElement.removeEventListener(`addmenuitem`,My(this,Wy)),this.submenuElement.removeEventListener(`removemenuitem`,My(this,Wy)),My(this,Wy).call(this)},Wy=new WeakMap,Gy=new WeakMap,Ky=new WeakMap,qy=new WeakSet,Jy=function(){let e=My(this,Ly)?.radioGroupItems;if(!e)return;let t=e.filter(e=>e.getAttribute(`aria-checked`)===`true`).pop();t||=e[0];for(let t of e)t.setAttribute(`aria-checked`,`false`);t?.setAttribute(`aria-checked`,`true`)},Qy.shadowRootOptions={mode:`open`},Qy.getTemplateHTML=Yy,Qy.getSuffixSlotInnerHTML=Xy;function $y(e){return e.type===`radio`||e.type===`checkbox`}function eb(e,t){if(!e)return null;let{host:n}=e.getRootNode();return!t&&n?eb(e,n):t?.items?t:eb(t,t?.parentNode)}N.customElements.get(`media-chrome-menu-item`)||N.customElements.define(`media-chrome-menu-item`,Qy);function tb(e){return`
    ${Oy.getTemplateHTML(e)}
    <style>
      :host {
        --_menu-bg: rgb(20 20 30 / .8);
        background: var(--media-settings-menu-background,
            var(--media-menu-background,
              var(--media-control-background,
                var(--media-secondary-color, var(--_menu-bg)))));
        min-width: var(--media-settings-menu-min-width, 170px);
        border-radius: 2px 2px 0 0;
        overflow: hidden;
      }

      @-moz-document url-prefix() {
        :host{
          --_menu-bg: rgb(20 20 30);
        }
      }

      :host([role="menu"]) {
        
        justify-content: end;
      }

      slot:not([name]) {
        justify-content: var(--media-settings-menu-justify-content);
        flex-direction: var(--media-settings-menu-flex-direction, column);
        overflow: visible;
      }

      #container.has-expanded {
        --media-settings-menu-item-opacity: 0;
      }
    </style>
  `}var nb=class extends Oy{get anchorElement(){return this.anchor===`auto`?mc(this).querySelector(`media-settings-menu-button`):super.anchorElement}};nb.getTemplateHTML=tb,N.customElements.get(`media-settings-menu`)||N.customElements.define(`media-settings-menu`,nb);function rb(e){return`
    ${Qy.getTemplateHTML.call(this,e)}
    <style>
      slot:not([name="submenu"]) {
        opacity: var(--media-settings-menu-item-opacity, var(--media-menu-item-opacity));
      }

      :host([aria-expanded="true"]:hover) {
        background: transparent;
      }
    </style>
  `}function ib(e){return`
    <svg aria-hidden="true" viewBox="0 0 20 24">
      <path d="m8.12 17.585-.742-.669 4.2-4.665-4.2-4.666.743-.669 4.803 5.335-4.803 5.334Z"/>
    </svg>
  `}var ab=class extends Qy{};ab.shadowRootOptions={mode:`open`},ab.getTemplateHTML=rb,ab.getSuffixSlotInnerHTML=ib,N.customElements.get(`media-settings-menu-item`)||N.customElements.define(`media-settings-menu-item`,ab);var ob=class extends lf{connectedCallback(){super.connectedCallback(),this.invokeTargetElement&&this.setAttribute(`aria-haspopup`,`menu`)}get invokeTarget(){return this.getAttribute(`invoketarget`)}set invokeTarget(e){this.setAttribute(`invoketarget`,`${e}`)}get invokeTargetElement(){return this.invokeTarget?Sc(this)?.querySelector(`#${this.invokeTarget}`):null}handleClick(){var e;(e=this.invokeTargetElement)==null||e.dispatchEvent(new Ov({relatedTarget:this}))}};N.customElements.get(`media-chrome-menu-button`)||N.customElements.define(`media-chrome-menu-button`,ob);function sb(){return`
    <style>
      :host([aria-expanded="true"]) slot[name=tooltip] {
        display: none;
      }
    </style>
    <slot name="icon">
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="M4.5 14.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Zm7.5 0a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Zm7.5 0a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z"/>
      </svg>
    </slot>
  `}function cb(){return M(`Settings`)}var lb=class extends ob{static get observedAttributes(){return[...super.observedAttributes,`target`]}connectedCallback(){super.connectedCallback(),this.setAttribute(`aria-label`,M(`settings`))}get invokeTargetElement(){return this.invokeTarget==null?mc(this).querySelector(`media-settings-menu`):super.invokeTargetElement}};lb.getSlotTemplateHTML=sb,lb.getTooltipContentHTML=cb,N.customElements.get(`media-settings-menu-button`)||N.customElements.define(`media-settings-menu-button`,lb);var ub=(e,t,n)=>{if(!t.has(e))throw TypeError(`Cannot `+n)},db=(e,t,n)=>(ub(e,t,`read from private field`),n?n.call(e):t.get(e)),fb=(e,t,n)=>{if(t.has(e))throw TypeError(`Cannot add the same private member more than once`);t instanceof WeakSet?t.add(e):t.set(e,n)},pb=(e,t,n,r)=>(ub(e,t,`write to private field`),r?r.call(e,n):t.set(e,n),n),mb=(e,t,n)=>(ub(e,t,`access private method`),n),hb,gb,_b,vb,yb,bb,xb=class extends Oy{constructor(){super(...arguments),fb(this,_b),fb(this,yb),fb(this,hb,[]),fb(this,gb,void 0)}static get observedAttributes(){return[...super.observedAttributes,j.MEDIA_AUDIO_TRACK_LIST,j.MEDIA_AUDIO_TRACK_ENABLED,j.MEDIA_AUDIO_TRACK_UNAVAILABLE]}attributeChangedCallback(e,t,n){super.attributeChangedCallback(e,t,n),e===j.MEDIA_AUDIO_TRACK_ENABLED&&t!==n?this.value=n:e===j.MEDIA_AUDIO_TRACK_LIST&&t!==n&&(pb(this,hb,Fs(n??``)),mb(this,_b,vb).call(this))}connectedCallback(){super.connectedCallback(),this.addEventListener(`change`,mb(this,yb,bb))}disconnectedCallback(){super.disconnectedCallback(),this.removeEventListener(`change`,mb(this,yb,bb))}get anchorElement(){return this.anchor===`auto`?mc(this)?.querySelector(`media-audio-track-menu-button`):super.anchorElement}get mediaAudioTrackList(){return db(this,hb)}set mediaAudioTrackList(e){pb(this,hb,e),mb(this,_b,vb).call(this)}get mediaAudioTrackEnabled(){return R(this,j.MEDIA_AUDIO_TRACK_ENABLED)??``}set mediaAudioTrackEnabled(e){z(this,j.MEDIA_AUDIO_TRACK_ENABLED,e)}};hb=new WeakMap,gb=new WeakMap,_b=new WeakSet,vb=function(){if(db(this,gb)===JSON.stringify(this.mediaAudioTrackList))return;pb(this,gb,JSON.stringify(this.mediaAudioTrackList));let e=this.mediaAudioTrackList;this.defaultSlot.textContent=``,e.sort((e,t)=>e.id.localeCompare(t.id,void 0,{numeric:!0}));for(let t of e){let e=wy({type:`radio`,text:this.formatMenuItemText(t.label,t),value:`${t.id}`,checked:t.enabled});e.prepend(Ty(this,`checked-indicator`)),this.defaultSlot.append(e)}},yb=new WeakSet,bb=function(){if(this.value==null)return;let e=new N.CustomEvent(k.MEDIA_AUDIO_TRACK_REQUEST,{composed:!0,bubbles:!0,detail:this.value});this.dispatchEvent(e)},N.customElements.get(`media-audio-track-menu`)||N.customElements.define(`media-audio-track-menu`,xb);var Sb=`<svg aria-hidden="true" viewBox="0 0 24 24">
  <path d="M11 17H9.5V7H11v10Zm-3-3H6.5v-4H8v4Zm6-5h-1.5v6H14V9Zm3 7h-1.5V8H17v8Z"/>
  <path d="M22 12c0 5.523-4.477 10-10 10S2 17.523 2 12 6.477 2 12 2s10 4.477 10 10Zm-2 0a8 8 0 1 0-16 0 8 8 0 0 0 16 0Z"/>
</svg>`;function Cb(){return`
    <style>
      :host([aria-expanded="true"]) slot[name=tooltip] {
        display: none;
      }
    </style>
    <slot name="icon">${Sb}</slot>
  `}function wb(){return M(`Audio`)}var Tb=e=>{let t=M(`Audio`);e.setAttribute(`aria-label`,t)},Eb=class extends ob{static get observedAttributes(){return[...super.observedAttributes,j.MEDIA_AUDIO_TRACK_ENABLED,j.MEDIA_AUDIO_TRACK_UNAVAILABLE]}connectedCallback(){super.connectedCallback(),Tb(this)}attributeChangedCallback(e,t,n){super.attributeChangedCallback(e,t,n),e===j.MEDIA_LANG&&Tb(this)}get invokeTargetElement(){return this.invokeTarget==null?mc(this)?.querySelector(`media-audio-track-menu`):super.invokeTargetElement}get mediaAudioTrackEnabled(){return R(this,j.MEDIA_AUDIO_TRACK_ENABLED)??``}set mediaAudioTrackEnabled(e){z(this,j.MEDIA_AUDIO_TRACK_ENABLED,e)}};Eb.getSlotTemplateHTML=Cb,Eb.getTooltipContentHTML=wb,N.customElements.get(`media-audio-track-menu-button`)||N.customElements.define(`media-audio-track-menu-button`,Eb);var Db=(e,t,n)=>{if(!t.has(e))throw TypeError(`Cannot `+n)},Ob=(e,t,n)=>(Db(e,t,`read from private field`),n?n.call(e):t.get(e)),kb=(e,t,n)=>{if(t.has(e))throw TypeError(`Cannot add the same private member more than once`);t instanceof WeakSet?t.add(e):t.set(e,n)},Ab=(e,t,n,r)=>(Db(e,t,`write to private field`),r?r.call(e,n):t.set(e,n),n),jb=(e,t,n)=>(Db(e,t,`access private method`),n),Mb,Nb,Pb,Fb,Ib,Lb=`
  <svg aria-hidden="true" viewBox="0 0 26 24" part="captions-indicator indicator">
    <path d="M22.83 5.68a2.58 2.58 0 0 0-2.3-2.5c-3.62-.24-11.44-.24-15.06 0a2.58 2.58 0 0 0-2.3 2.5c-.23 4.21-.23 8.43 0 12.64a2.58 2.58 0 0 0 2.3 2.5c3.62.24 11.44.24 15.06 0a2.58 2.58 0 0 0 2.3-2.5c.23-4.21.23-8.43 0-12.64Zm-11.39 9.45a3.07 3.07 0 0 1-1.91.57 3.06 3.06 0 0 1-2.34-1 3.75 3.75 0 0 1-.92-2.67 3.92 3.92 0 0 1 .92-2.77 3.18 3.18 0 0 1 2.43-1 2.94 2.94 0 0 1 2.13.78c.364.359.62.813.74 1.31l-1.43.35a1.49 1.49 0 0 0-1.51-1.17 1.61 1.61 0 0 0-1.29.58 2.79 2.79 0 0 0-.5 1.89 3 3 0 0 0 .49 1.93 1.61 1.61 0 0 0 1.27.58 1.48 1.48 0 0 0 1-.37 2.1 2.1 0 0 0 .59-1.14l1.4.44a3.23 3.23 0 0 1-1.07 1.69Zm7.22 0a3.07 3.07 0 0 1-1.91.57 3.06 3.06 0 0 1-2.34-1 3.75 3.75 0 0 1-.92-2.67 3.88 3.88 0 0 1 .93-2.77 3.14 3.14 0 0 1 2.42-1 3 3 0 0 1 2.16.82 2.8 2.8 0 0 1 .73 1.31l-1.43.35a1.49 1.49 0 0 0-1.51-1.21 1.61 1.61 0 0 0-1.29.58A2.79 2.79 0 0 0 15 12a3 3 0 0 0 .49 1.93 1.61 1.61 0 0 0 1.27.58 1.44 1.44 0 0 0 1-.37 2.1 2.1 0 0 0 .6-1.15l1.4.44a3.17 3.17 0 0 1-1.1 1.7Z"/>
  </svg>`;function Rb(e){return`
    ${Oy.getTemplateHTML(e)}
    <slot name="captions-indicator" hidden>${Lb}</slot>
  `}var zb=class extends Oy{constructor(){super(...arguments),kb(this,Nb),kb(this,Fb),kb(this,Mb,void 0)}static get observedAttributes(){return[...super.observedAttributes,j.MEDIA_SUBTITLES_LIST,j.MEDIA_SUBTITLES_SHOWING]}attributeChangedCallback(e,t,n){super.attributeChangedCallback(e,t,n),e===j.MEDIA_SUBTITLES_LIST&&t!==n?jb(this,Nb,Pb).call(this):e===j.MEDIA_SUBTITLES_SHOWING&&t!==n&&(this.value=n||``,jb(this,Nb,Pb).call(this))}connectedCallback(){super.connectedCallback(),this.addEventListener(`change`,jb(this,Fb,Ib))}disconnectedCallback(){super.disconnectedCallback(),this.removeEventListener(`change`,jb(this,Fb,Ib))}get anchorElement(){return this.anchor===`auto`?mc(this).querySelector(`media-captions-menu-button`):super.anchorElement}get mediaSubtitlesList(){return Bb(this,j.MEDIA_SUBTITLES_LIST)}set mediaSubtitlesList(e){Vb(this,j.MEDIA_SUBTITLES_LIST,e)}get mediaSubtitlesShowing(){return Bb(this,j.MEDIA_SUBTITLES_SHOWING)}set mediaSubtitlesShowing(e){Vb(this,j.MEDIA_SUBTITLES_SHOWING,e)}};Mb=new WeakMap,Nb=new WeakSet,Pb=function(){let e=Ob(this,Mb)!==JSON.stringify(this.mediaSubtitlesList),t=this.value!==this.getAttribute(j.MEDIA_SUBTITLES_SHOWING);if(!e&&!t)return;Ab(this,Mb,JSON.stringify(this.mediaSubtitlesList)),this.defaultSlot.textContent=``;let n=!this.value,r=wy({type:`radio`,text:this.formatMenuItemText(M(`Off`)),value:`off`,checked:n});r.prepend(Ty(this,`checked-indicator`)),this.defaultSlot.append(r);let i=this.mediaSubtitlesList;for(let e of i){let t=wy({type:`radio`,text:this.formatMenuItemText(e.label,e),value:pu(e),checked:this.value==pu(e)});t.prepend(Ty(this,`checked-indicator`)),(e.kind??`subs`)===`captions`&&t.append(Ty(this,`captions-indicator`)),this.defaultSlot.append(t)}},Fb=new WeakSet,Ib=function(){let e=this.mediaSubtitlesShowing,t=this.getAttribute(j.MEDIA_SUBTITLES_SHOWING),n=this.value!==t;if(e?.length&&n&&this.dispatchEvent(new N.CustomEvent(k.MEDIA_DISABLE_SUBTITLES_REQUEST,{composed:!0,bubbles:!0,detail:e})),!this.value||!n)return;let r=new N.CustomEvent(k.MEDIA_SHOW_SUBTITLES_REQUEST,{composed:!0,bubbles:!0,detail:this.value});this.dispatchEvent(r)},zb.getTemplateHTML=Rb;var Bb=(e,t)=>{let n=e.getAttribute(t);return n?du(n):[]},Vb=(e,t,n)=>{if(!n?.length){e.removeAttribute(t);return}let r=mu(n);e.getAttribute(t)!==r&&e.setAttribute(t,r)};N.customElements.get(`media-captions-menu`)||N.customElements.define(`media-captions-menu`,zb);var Hb=`<svg aria-hidden="true" viewBox="0 0 26 24">
  <path d="M22.83 5.68a2.58 2.58 0 0 0-2.3-2.5c-3.62-.24-11.44-.24-15.06 0a2.58 2.58 0 0 0-2.3 2.5c-.23 4.21-.23 8.43 0 12.64a2.58 2.58 0 0 0 2.3 2.5c3.62.24 11.44.24 15.06 0a2.58 2.58 0 0 0 2.3-2.5c.23-4.21.23-8.43 0-12.64Zm-11.39 9.45a3.07 3.07 0 0 1-1.91.57 3.06 3.06 0 0 1-2.34-1 3.75 3.75 0 0 1-.92-2.67 3.92 3.92 0 0 1 .92-2.77 3.18 3.18 0 0 1 2.43-1 2.94 2.94 0 0 1 2.13.78c.364.359.62.813.74 1.31l-1.43.35a1.49 1.49 0 0 0-1.51-1.17 1.61 1.61 0 0 0-1.29.58 2.79 2.79 0 0 0-.5 1.89 3 3 0 0 0 .49 1.93 1.61 1.61 0 0 0 1.27.58 1.48 1.48 0 0 0 1-.37 2.1 2.1 0 0 0 .59-1.14l1.4.44a3.23 3.23 0 0 1-1.07 1.69Zm7.22 0a3.07 3.07 0 0 1-1.91.57 3.06 3.06 0 0 1-2.34-1 3.75 3.75 0 0 1-.92-2.67 3.88 3.88 0 0 1 .93-2.77 3.14 3.14 0 0 1 2.42-1 3 3 0 0 1 2.16.82 2.8 2.8 0 0 1 .73 1.31l-1.43.35a1.49 1.49 0 0 0-1.51-1.21 1.61 1.61 0 0 0-1.29.58A2.79 2.79 0 0 0 15 12a3 3 0 0 0 .49 1.93 1.61 1.61 0 0 0 1.27.58 1.44 1.44 0 0 0 1-.37 2.1 2.1 0 0 0 .6-1.15l1.4.44a3.17 3.17 0 0 1-1.1 1.7Z"/>
</svg>`,Ub=`<svg aria-hidden="true" viewBox="0 0 26 24">
  <path d="M17.73 14.09a1.4 1.4 0 0 1-1 .37 1.579 1.579 0 0 1-1.27-.58A3 3 0 0 1 15 12a2.8 2.8 0 0 1 .5-1.85 1.63 1.63 0 0 1 1.29-.57 1.47 1.47 0 0 1 1.51 1.2l1.43-.34A2.89 2.89 0 0 0 19 9.07a3 3 0 0 0-2.14-.78 3.14 3.14 0 0 0-2.42 1 3.91 3.91 0 0 0-.93 2.78 3.74 3.74 0 0 0 .92 2.66 3.07 3.07 0 0 0 2.34 1 3.07 3.07 0 0 0 1.91-.57 3.17 3.17 0 0 0 1.07-1.74l-1.4-.45c-.083.43-.3.822-.62 1.12Zm-7.22 0a1.43 1.43 0 0 1-1 .37 1.58 1.58 0 0 1-1.27-.58A3 3 0 0 1 7.76 12a2.8 2.8 0 0 1 .5-1.85 1.63 1.63 0 0 1 1.29-.57 1.47 1.47 0 0 1 1.51 1.2l1.43-.34a2.81 2.81 0 0 0-.74-1.32 2.94 2.94 0 0 0-2.13-.78 3.18 3.18 0 0 0-2.43 1 4 4 0 0 0-.92 2.78 3.74 3.74 0 0 0 .92 2.66 3.07 3.07 0 0 0 2.34 1 3.07 3.07 0 0 0 1.91-.57 3.23 3.23 0 0 0 1.07-1.74l-1.4-.45a2.06 2.06 0 0 1-.6 1.07Zm12.32-8.41a2.59 2.59 0 0 0-2.3-2.51C18.72 3.05 15.86 3 13 3c-2.86 0-5.72.05-7.53.17a2.59 2.59 0 0 0-2.3 2.51c-.23 4.207-.23 8.423 0 12.63a2.57 2.57 0 0 0 2.3 2.5c1.81.13 4.67.19 7.53.19 2.86 0 5.72-.06 7.53-.19a2.57 2.57 0 0 0 2.3-2.5c.23-4.207.23-8.423 0-12.63Zm-1.49 12.53a1.11 1.11 0 0 1-.91 1.11c-1.67.11-4.45.18-7.43.18-2.98 0-5.76-.07-7.43-.18a1.11 1.11 0 0 1-.91-1.11c-.21-4.14-.21-8.29 0-12.43a1.11 1.11 0 0 1 .91-1.11C7.24 4.56 10 4.49 13 4.49s5.76.07 7.43.18a1.11 1.11 0 0 1 .91 1.11c.21 4.14.21 8.29 0 12.43Z"/>
</svg>`;function Wb(){return`
    <style>
      :host([data-captions-enabled="true"]) slot[name=off] {
        display: none !important;
      }

      
      :host(:not([data-captions-enabled="true"])) slot[name=on] {
        display: none !important;
      }

      :host([aria-expanded="true"]) slot[name=tooltip] {
        display: none;
      }
    </style>

    <slot name="icon">
      <slot name="on">${Hb}</slot>
      <slot name="off">${Ub}</slot>
    </slot>
  `}function Gb(){return M(`Captions`)}var Kb=e=>{e.setAttribute(`data-captions-enabled`,yu(e).toString())},qb=e=>{e.setAttribute(`aria-label`,M(`closed captions`))},Jb=class extends ob{static get observedAttributes(){return[...super.observedAttributes,j.MEDIA_SUBTITLES_LIST,j.MEDIA_SUBTITLES_SHOWING,j.MEDIA_LANG]}connectedCallback(){super.connectedCallback(),qb(this),Kb(this)}attributeChangedCallback(e,t,n){super.attributeChangedCallback(e,t,n),e===j.MEDIA_SUBTITLES_SHOWING?Kb(this):e===j.MEDIA_LANG&&qb(this)}get invokeTargetElement(){return this.invokeTarget==null?mc(this)?.querySelector(`media-captions-menu`):super.invokeTargetElement}get mediaSubtitlesList(){return Yb(this,j.MEDIA_SUBTITLES_LIST)}set mediaSubtitlesList(e){Xb(this,j.MEDIA_SUBTITLES_LIST,e)}get mediaSubtitlesShowing(){return Yb(this,j.MEDIA_SUBTITLES_SHOWING)}set mediaSubtitlesShowing(e){Xb(this,j.MEDIA_SUBTITLES_SHOWING,e)}};Jb.getSlotTemplateHTML=Wb,Jb.getTooltipContentHTML=Gb;var Yb=(e,t)=>{let n=e.getAttribute(t);return n?du(n):[]},Xb=(e,t,n)=>{if(!n?.length){e.removeAttribute(t);return}let r=mu(n);e.getAttribute(t)!==r&&e.setAttribute(t,r)};N.customElements.get(`media-captions-menu-button`)||N.customElements.define(`media-captions-menu-button`,Jb);var Zb=(e,t,n)=>{if(!t.has(e))throw TypeError(`Cannot `+n)},Qb=(e,t,n)=>(Zb(e,t,`read from private field`),n?n.call(e):t.get(e)),$b=(e,t,n)=>{if(t.has(e))throw TypeError(`Cannot add the same private member more than once`);t instanceof WeakSet?t.add(e):t.set(e,n)},ex=(e,t,n)=>(Zb(e,t,`access private method`),n),tx,nx,rx,ix,ax,ox={RATES:`rates`},sx=class extends Oy{constructor(){super(),$b(this,nx),$b(this,ix),$b(this,tx,new cu(this,ox.RATES,{defaultValue:Im})),ex(this,nx,rx).call(this)}static get observedAttributes(){return[...super.observedAttributes,j.MEDIA_PLAYBACK_RATE,ox.RATES]}attributeChangedCallback(e,t,n){super.attributeChangedCallback(e,t,n),e===j.MEDIA_PLAYBACK_RATE&&t!=n?(this.value=n,ex(this,nx,rx).call(this)):e===ox.RATES&&t!=n&&(Qb(this,tx).value=n,ex(this,nx,rx).call(this))}connectedCallback(){super.connectedCallback(),this.addEventListener(`change`,ex(this,ix,ax))}disconnectedCallback(){super.disconnectedCallback(),this.removeEventListener(`change`,ex(this,ix,ax))}get anchorElement(){return this.anchor===`auto`?mc(this).querySelector(`media-playback-rate-menu-button`):super.anchorElement}get rates(){return Qb(this,tx)}set rates(e){e?Array.isArray(e)?Qb(this,tx).value=e.join(` `):typeof e==`string`&&(Qb(this,tx).value=e):Qb(this,tx).value=``,ex(this,nx,rx).call(this)}get mediaPlaybackRate(){return P(this,j.MEDIA_PLAYBACK_RATE,1)}set mediaPlaybackRate(e){F(this,j.MEDIA_PLAYBACK_RATE,e)}};tx=new WeakMap,nx=new WeakSet,rx=function(){this.defaultSlot.textContent=``;let e=Lm(this.mediaPlaybackRate),t=new Set(Array.from(Qb(this,tx)).map(e=>Lm(Number(e))));e>0&&!t.has(e)&&t.add(e);let n=Array.from(t).sort((e,t)=>e-t);for(let t of n){let n=wy({type:`radio`,text:this.formatMenuItemText(`${t}x`,t),value:t.toString(),checked:e===t});n.prepend(Ty(this,`checked-indicator`)),this.defaultSlot.append(n)}},ix=new WeakSet,ax=function(){if(!this.value)return;let e=new N.CustomEvent(k.MEDIA_PLAYBACK_RATE_REQUEST,{composed:!0,bubbles:!0,detail:this.value});this.dispatchEvent(e)},N.customElements.get(`media-playback-rate-menu`)||N.customElements.define(`media-playback-rate-menu`,sx);function cx(e){return`
    <style>
      :host {
        min-width: 5ch;
        padding: var(--media-button-padding, var(--media-control-padding, 10px 5px));
      }

      :host([aria-expanded="true"]) slot {
        display: block;
      }

      :host([aria-expanded="true"]) slot[name=tooltip] {
        display: none;
      }
    </style>
    <slot name="icon">${e.mediaplaybackrate?Lm(+e.mediaplaybackrate):1}x</slot>
  `}function lx(){return M(`Playback rate`)}var ux=class extends ob{static get observedAttributes(){return[...super.observedAttributes,j.MEDIA_PLAYBACK_RATE]}constructor(){super(),this.container=this.shadowRoot.querySelector(`slot[name="icon"]`),this.container.innerHTML=`${Lm(this.mediaPlaybackRate??1)}x`}attributeChangedCallback(e,t,n){if(super.attributeChangedCallback(e,t,n),e===j.MEDIA_PLAYBACK_RATE){let e=n?+n:NaN,t=Lm(Number.isNaN(e)?1:e);this.container.innerHTML=`${t}x`,this.setAttribute(`aria-label`,M(`Playback rate {playbackRate}`,{playbackRate:t}))}}get invokeTargetElement(){return this.invokeTarget==null?mc(this).querySelector(`media-playback-rate-menu`):super.invokeTargetElement}get mediaPlaybackRate(){return P(this,j.MEDIA_PLAYBACK_RATE,1)}set mediaPlaybackRate(e){F(this,j.MEDIA_PLAYBACK_RATE,e)}};ux.getSlotTemplateHTML=cx,ux.getTooltipContentHTML=lx,N.customElements.get(`media-playback-rate-menu-button`)||N.customElements.define(`media-playback-rate-menu-button`,ux);var dx=(e,t,n)=>{if(!t.has(e))throw TypeError(`Cannot `+n)},fx=(e,t,n)=>(dx(e,t,`read from private field`),n?n.call(e):t.get(e)),px=(e,t,n)=>{if(t.has(e))throw TypeError(`Cannot add the same private member more than once`);t instanceof WeakSet?t.add(e):t.set(e,n)},mx=(e,t,n,r)=>(dx(e,t,`write to private field`),r?r.call(e,n):t.set(e,n),n),hx=(e,t,n)=>(dx(e,t,`access private method`),n),gx,_x,vx,yx,bx,xx,Sx=class extends Oy{constructor(){super(...arguments),px(this,vx),px(this,bx),px(this,gx,[]),px(this,_x,{})}static get observedAttributes(){return[...super.observedAttributes,j.MEDIA_RENDITION_LIST,j.MEDIA_RENDITION_SELECTED,j.MEDIA_RENDITION_UNAVAILABLE,j.MEDIA_HEIGHT,j.MEDIA_WIDTH]}static formatMenuItemText(e,t){return super.formatMenuItemText(e,t)}static formatRendition(e,{showBitrate:t=!1}={}){let n=`${Math.min(e.width,e.height)}p`;if(t&&e.bitrate){let t=e.bitrate/1e6;return`${n} (${`${t.toFixed(+(t<1))} Mbps`})`}return this.formatMenuItemText(n,e)}static compareRendition(e,t){return t.height===e.height?(t.bitrate??0)-(e.bitrate??0):t.height-e.height}attributeChangedCallback(e,t,n){if(super.attributeChangedCallback(e,t,n),t!==n)switch(e){case j.MEDIA_RENDITION_SELECTED:this.value=n??`auto`,hx(this,vx,yx).call(this);break;case j.MEDIA_RENDITION_LIST:mx(this,gx,js(n)),hx(this,vx,yx).call(this);break;case j.MEDIA_HEIGHT:case j.MEDIA_WIDTH:hx(this,vx,yx).call(this)}}connectedCallback(){super.connectedCallback(),this.addEventListener(`change`,hx(this,bx,xx))}disconnectedCallback(){super.disconnectedCallback(),this.removeEventListener(`change`,hx(this,bx,xx))}get anchorElement(){return this.anchor===`auto`?mc(this).querySelector(`media-rendition-menu-button`):super.anchorElement}get mediaRenditionList(){return fx(this,gx)}set mediaRenditionList(e){mx(this,gx,e),hx(this,vx,yx).call(this)}get mediaRenditionSelected(){return R(this,j.MEDIA_RENDITION_SELECTED)}set mediaRenditionSelected(e){z(this,j.MEDIA_RENDITION_SELECTED,e)}get mediaHeight(){return P(this,j.MEDIA_HEIGHT)}set mediaHeight(e){F(this,j.MEDIA_HEIGHT,e)}get mediaWidth(){return P(this,j.MEDIA_WIDTH)}set mediaWidth(e){F(this,j.MEDIA_WIDTH,e)}compareRendition(e,t){return this.constructor.compareRendition(e,t)}formatMenuItemText(e,t){return this.constructor.formatMenuItemText(e,t)}formatRendition(e,t){return this.constructor.formatRendition(e,t)}showRenditionBitrate(e){return this.mediaRenditionList.some(t=>t!==e&&t.height===e.height&&t.bitrate!==e.bitrate)}};gx=new WeakMap,_x=new WeakMap,vx=new WeakSet,yx=function(){let e=!this.mediaRenditionSelected;if(fx(this,_x).mediaRenditionList===JSON.stringify(this.mediaRenditionList)&&fx(this,_x).mediaHeight===this.mediaHeight&&fx(this,_x).mediaWidth===this.mediaWidth&&fx(this,_x).isAuto===e)return;fx(this,_x).mediaRenditionList=JSON.stringify(this.mediaRenditionList),fx(this,_x).mediaHeight=this.mediaHeight,fx(this,_x).mediaWidth=this.mediaWidth,fx(this,_x).isAuto=e;let t=this.mediaRenditionList.sort(this.compareRendition.bind(this)),n=t.find(e=>e.id===this.mediaRenditionSelected);for(let e of t)e.selected=e===n;this.defaultSlot.textContent=``;for(let n of t){let t=wy({type:`radio`,text:this.formatRendition(n,{showBitrate:this.showRenditionBitrate(n)}),value:`${n.id}`,checked:n.selected&&!e});t.prepend(Ty(this,`checked-indicator`)),this.defaultSlot.append(t)}let r=n&&this.showRenditionBitrate(n),i;e&&(n?i=this.formatMenuItemText(`${M(`Auto`)} \u2022 ${this.formatRendition(n,{showBitrate:r})}`,n):this.mediaHeight>0&&this.mediaWidth>0&&(i=this.formatMenuItemText(`${M(`Auto`)} (${Math.min(this.mediaWidth,this.mediaHeight)}p)`))),i||=this.formatMenuItemText(M(`Auto`));let a=wy({type:`radio`,text:i,value:`auto`,checked:e});a.dataset.description=i,a.prepend(Ty(this,`checked-indicator`)),this.defaultSlot.append(a)},bx=new WeakSet,xx=function(){if(this.value==null)return;let e=new N.CustomEvent(k.MEDIA_RENDITION_REQUEST,{composed:!0,bubbles:!0,detail:this.value});this.dispatchEvent(e)},N.customElements.get(`media-rendition-menu`)||N.customElements.define(`media-rendition-menu`,Sx);var Cx=`<svg aria-hidden="true" viewBox="0 0 24 24">
  <path d="M13.5 2.5h2v6h-2v-2h-11v-2h11v-2Zm4 2h4v2h-4v-2Zm-12 4h2v6h-2v-2h-3v-2h3v-2Zm4 2h12v2h-12v-2Zm1 4h2v6h-2v-2h-8v-2h8v-2Zm4 2h7v2h-7v-2Z" />
</svg>`;function wx(){return`
    <style>
      :host([aria-expanded="true"]) slot[name=tooltip] {
        display: none;
      }
    </style>
    <slot name="icon">${Cx}</slot>
  `}function Tx(){return M(`Quality`)}var Ex=class extends ob{static get observedAttributes(){return[...super.observedAttributes,j.MEDIA_RENDITION_SELECTED,j.MEDIA_RENDITION_UNAVAILABLE,j.MEDIA_HEIGHT]}connectedCallback(){super.connectedCallback(),this.setAttribute(`aria-label`,M(`quality`))}get invokeTargetElement(){return this.invokeTarget==null?mc(this).querySelector(`media-rendition-menu`):super.invokeTargetElement}get mediaRenditionSelected(){return R(this,j.MEDIA_RENDITION_SELECTED)}set mediaRenditionSelected(e){z(this,j.MEDIA_RENDITION_SELECTED,e)}get mediaHeight(){return P(this,j.MEDIA_HEIGHT)}set mediaHeight(e){F(this,j.MEDIA_HEIGHT,e)}};Ex.getSlotTemplateHTML=wx,Ex.getTooltipContentHTML=Tx,N.customElements.get(`media-rendition-menu-button`)||N.customElements.define(`media-rendition-menu-button`,Ex);var Dx=(e,t,n)=>{if(!t.has(e))throw TypeError(`Cannot `+n)},Ox=(e,t,n)=>(Dx(e,t,`read from private field`),n?n.call(e):t.get(e)),kx=(e,t,n)=>{if(t.has(e))throw TypeError(`Cannot add the same private member more than once`);t instanceof WeakSet?t.add(e):t.set(e,n)},Ax=(e,t,n,r)=>(Dx(e,t,`write to private field`),r?r.call(e,n):t.set(e,n),n),jx=(e,t,n)=>(Dx(e,t,`access private method`),n),Mx,Nx,Px,Fx,Ix,Lx,Rx,zx,Bx,Vx,Hx,Ux,Wx,Gx,Kx;function qx(e){return`
      ${Oy.getTemplateHTML(e)}
      <style>
        :host {
          --_menu-bg: rgb(20 20 30 / .8);
          background: var(--media-settings-menu-background,
            var(--media-menu-background,
              var(--media-control-background,
                var(--media-secondary-color, var(--_menu-bg)))));
          min-width: var(--media-settings-menu-min-width, 170px);
          border-radius: 2px;
          overflow: hidden;
        }
      </style>
    `}var Jx=class extends Oy{constructor(){super(),kx(this,Nx),kx(this,Fx),kx(this,Lx),kx(this,zx),kx(this,Hx),kx(this,Mx,!1),kx(this,Vx,e=>{let t=e.target,n=t?.nodeName===`VIDEO`,r=jx(this,zx,Bx).call(this,t);(n||r)&&(Ox(this,Mx)?jx(this,Fx,Ix).call(this):jx(this,Hx,Ux).call(this,e))}),kx(this,Wx,e=>{let t=e.target,n=this.contains(t),r=e.button===2,i=t?.nodeName===`VIDEO`,a=jx(this,zx,Bx).call(this,t);n||r&&(i||a)||jx(this,Fx,Ix).call(this)}),kx(this,Gx,e=>{e.key===`Escape`&&jx(this,Fx,Ix).call(this)}),kx(this,Kx,e=>{let t=e.target;if(t.matches?.call(t,`button[invoke="copy"]`)){let e=t.closest(`media-context-menu-item`)?.querySelector(`input[slot="copy"]`);e&&navigator.clipboard.writeText(e.value)}jx(this,Fx,Ix).call(this)}),this.setAttribute(`noautohide`,``),jx(this,Nx,Px).call(this)}connectedCallback(){super.connectedCallback(),mc(this).addEventListener(`contextmenu`,Ox(this,Vx)),this.addEventListener(`click`,Ox(this,Kx))}disconnectedCallback(){super.disconnectedCallback(),mc(this).removeEventListener(`contextmenu`,Ox(this,Vx)),this.removeEventListener(`click`,Ox(this,Kx)),document.removeEventListener(`mousedown`,Ox(this,Wx)),document.removeEventListener(`keydown`,Ox(this,Gx))}};Mx=new WeakMap,Nx=new WeakSet,Px=function(){this.hidden=!Ox(this,Mx)},Fx=new WeakSet,Ix=function(){Ax(this,Mx,!1),jx(this,Nx,Px).call(this)},Lx=new WeakSet,Rx=function(){document.querySelectorAll(`media-context-menu`).forEach(e=>{var t;e!==this&&jx(t=e,Fx,Ix).call(t)})},zx=new WeakSet,Bx=function(e){return e?e.hasAttribute(`slot`)&&e.getAttribute(`slot`)===`media`?!0:e.nodeName.includes(`-`)&&e.tagName.includes(`-`)?e.hasAttribute(`src`)||e.hasAttribute(`poster`)||e.hasAttribute(`preload`)||e.hasAttribute(`playsinline`):!1:!1},Vx=new WeakMap,Hx=new WeakSet,Ux=function(e){e.preventDefault(),jx(this,Lx,Rx).call(this),Ax(this,Mx,!0),this.style.position=`fixed`,this.style.left=`${e.clientX}px`,this.style.top=`${e.clientY}px`,jx(this,Nx,Px).call(this),document.addEventListener(`mousedown`,Ox(this,Wx),{once:!0}),document.addEventListener(`keydown`,Ox(this,Gx),{once:!0})},Wx=new WeakMap,Gx=new WeakMap,Kx=new WeakMap,Jx.getTemplateHTML=qx,N.customElements.get(`media-context-menu`)||N.customElements.define(`media-context-menu`,Jx);function Yx(e){return`
    ${Qy.getTemplateHTML.call(this,e)}
    <style>
        ::slotted(*) {
            color: var(--media-text-color, white);
            text-decoration: none;
            border: none;
            background: none;
            cursor: pointer;
            padding: 0;
            min-height: var(--media-control-height, 24px);
        }
    </style>
  `}var Xx=class extends Qy{};Xx.shadowRootOptions={mode:`open`},Xx.getTemplateHTML=Yx,N.customElements.get(`media-context-menu-item`)||N.customElements.define(`media-context-menu-item`,Xx);var Zx=e=>{throw TypeError(e)},Qx=(e,t,n)=>t.has(e)||Zx(`Cannot `+n),X=(e,t,n)=>(Qx(e,t,`read from private field`),n?n.call(e):t.get(e)),$x=(e,t,n)=>t.has(e)?Zx(`Cannot add the same private member more than once`):t instanceof WeakSet?t.add(e):t.set(e,n),eS=(e,t,n,r)=>(Qx(e,t,`write to private field`),r?r.call(e,n):t.set(e,n),n),tS=(e,t,n)=>(Qx(e,t,`access private method`),n),nS=class{addEventListener(){}removeEventListener(){}dispatchEvent(e){return!0}};if(typeof DocumentFragment>`u`){class e extends nS{}globalThis.DocumentFragment=e}var rS=class extends nS{},iS=class extends nS{},aS={get(e){},define(e,t,n){},getName(e){return null},upgrade(e){},whenDefined(e){return Promise.resolve(rS)}},oS,sS=class{constructor(e,t={}){$x(this,oS),eS(this,oS,t?.detail)}get detail(){return X(this,oS)}initCustomEvent(){}};oS=new WeakMap;function cS(e,t){return new rS}var lS={document:{createElement:cS},DocumentFragment,customElements:aS,CustomEvent:sS,EventTarget:nS,HTMLElement:rS,HTMLVideoElement:iS},uS=typeof window>`u`||globalThis.customElements===void 0,dS=uS?lS:globalThis,fS=uS?lS.document:globalThis.document;function pS(e){return e.replace(/&/g,`&amp;`).replace(/</g,`&lt;`).replace(/>/g,`&gt;`).replace(/"/g,`&quot;`).replace(/'/g,`&#39;`)}function mS(e){let t=``;return Object.entries(e).forEach(([e,n])=>{n!=null&&(t+=`${hS(e)}: ${n}; `)}),t?t.trim():void 0}function hS(e){return e.replace(/([a-z])([A-Z])/g,`$1-$2`).toLowerCase()}function gS(e){return e.replace(/[-_]([a-z])/g,(e,t)=>t.toUpperCase())}function _S(e){if(e==null)return;let t=+e;return Number.isNaN(t)?void 0:t}function vS(e){let t=yS(e).toString();return t?`?`+t:``}function yS(e){let t={};for(let n in e)e[n]!=null&&(t[n]=e[n]);return new URLSearchParams(t)}var bS=(e,t)=>!e||!t?!1:e.contains(t)?!0:bS(e,t.getRootNode().host),xS=`mux.com`,SS=(()=>{try{return`3.14.1`}catch{}return`UNKNOWN`})(),CS=()=>SS,wS=(e,{token:t,customDomain:n=xS,thumbnailTime:r,programTime:i}={})=>{let a=t==null?r:void 0,{aud:o}=kr(t)??{};if(!(t&&o!==`t`))return`https://image.${n}/${e}/thumbnail.webp${vS({token:t,time:a,program_time:i})}`},TS=(e,{token:t,customDomain:n=xS,programStartTime:r,programEndTime:i}={})=>{let{aud:a}=kr(t)??{};if(!(t&&a!==`s`))return`https://image.${n}/${e}/storyboard.vtt${vS({token:t,format:`webp`,program_start_time:r,program_end_time:i})}`},ES=e=>{if(e){if([w.LIVE,w.ON_DEMAND].includes(e))return e;if(e!=null&&e.includes(`live`))return w.LIVE}},DS={crossorigin:`crossOrigin`,playsinline:`playsInline`};function OS(e){return DS[e]??gS(e)}var kS,AS,jS,MS=class{constructor(e,t){$x(this,kS),$x(this,AS),$x(this,jS,[]),eS(this,kS,e),eS(this,AS,t)}[Symbol.iterator](){return X(this,jS).values()}get length(){return X(this,jS).length}get value(){return X(this,jS).join(` `)??``}set value(e){e!==this.value&&(eS(this,jS,[]),this.add(...e?.split(` `)??[]))}toString(){return this.value}item(e){return X(this,jS)[e]}values(){return X(this,jS).values()}keys(){return X(this,jS).keys()}forEach(e){X(this,jS).forEach(e)}add(...e){var t,n;e.forEach(e=>{this.contains(e)||X(this,jS).push(e)}),(this.value!==``||(t=X(this,kS))!=null&&t.hasAttribute(`${X(this,AS)}`))&&((n=X(this,kS))==null||n.setAttribute(`${X(this,AS)}`,`${this.value}`))}remove(...e){var t;e.forEach(e=>{X(this,jS).splice(X(this,jS).indexOf(e),1)}),(t=X(this,kS))==null||t.setAttribute(`${X(this,AS)}`,`${this.value}`)}contains(e){return X(this,jS).includes(e)}toggle(e,t){return t===void 0?this.contains(e)?(this.remove(e),!1):(this.add(e),!0):t?(this.add(e),!0):(this.remove(e),!1)}replace(e,t){this.remove(e),this.add(t)}};kS=new WeakMap,AS=new WeakMap,jS=new WeakMap;var NS=`[mux-player ${CS()}]`;function PS(...e){console.warn(NS,...e)}function FS(...e){console.error(NS,...e)}function IS(e){let t=e.message??``;e.context&&(t+=` ${e.context}`),e.file&&(t+=` ${E(`Read more: `)}
https://github.com/muxinc/elements/blob/main/errors/${e.file}`),PS(t)}var LS={AUTOPLAY:`autoplay`,CROSSORIGIN:`crossorigin`,LOOP:`loop`,MUTED:`muted`,PLAYSINLINE:`playsinline`,PRELOAD:`preload`},RS={VOLUME:`volume`,PLAYBACKRATE:`playbackrate`,MUTED:`muted`};({...LS,...RS});var zS=Object.freeze({length:0,start(e){let t=e>>>0;if(t>=this.length)throw new DOMException(`Failed to execute 'start' on 'TimeRanges': The index provided (${t}) is greater than or equal to the maximum bound (${this.length}).`);return 0},end(e){let t=e>>>0;if(t>=this.length)throw new DOMException(`Failed to execute 'end' on 'TimeRanges': The index provided (${t}) is greater than or equal to the maximum bound (${this.length}).`);return 0}}),BS=Object.values(LS).filter(e=>LS.PLAYSINLINE!==e),VS=Object.values(RS),HS=[...BS,...VS],US=class extends dS.HTMLElement{static get observedAttributes(){return HS}constructor(){super()}attributeChangedCallback(e,t,n){switch(e){case RS.MUTED:this.media&&(this.media.muted=n!=null,this.media.defaultMuted=n!=null);return;case RS.VOLUME:{let e=_S(n)??1;this.media&&(this.media.volume=e);return}case RS.PLAYBACKRATE:{let e=_S(n)??1;this.media&&(this.media.playbackRate=e,this.media.defaultPlaybackRate=e);return}}}play(){return this.media?.play()??Promise.reject()}pause(){var e;(e=this.media)==null||e.pause()}load(){var e;(e=this.media)==null||e.load()}get media(){return this.shadowRoot?.querySelector(`mux-video`)}get audioTracks(){return this.media.audioTracks}get videoTracks(){return this.media.videoTracks}get audioRenditions(){return this.media.audioRenditions}get videoRenditions(){return this.media.videoRenditions}get paused(){return this.media?.paused??!0}get duration(){return this.media?.duration??NaN}get ended(){return this.media?.ended??!1}get buffered(){return this.media?.buffered??zS}get seekable(){return this.media?.seekable??zS}get readyState(){return this.media?.readyState??0}get videoWidth(){return this.media?.videoWidth??0}get videoHeight(){return this.media?.videoHeight??0}get currentSrc(){return this.media?.currentSrc??``}get currentTime(){return this.media?.currentTime??0}set currentTime(e){this.media&&(this.media.currentTime=Number(e))}get volume(){return this.media?.volume??1}set volume(e){this.media&&(this.media.volume=Number(e))}get playbackRate(){return this.media?.playbackRate??1}set playbackRate(e){this.media&&(this.media.playbackRate=Number(e))}get defaultPlaybackRate(){return _S(this.getAttribute(RS.PLAYBACKRATE))??1}set defaultPlaybackRate(e){e==null?this.removeAttribute(RS.PLAYBACKRATE):this.setAttribute(RS.PLAYBACKRATE,`${e}`)}get crossOrigin(){return WS(this,LS.CROSSORIGIN)}set crossOrigin(e){this.setAttribute(LS.CROSSORIGIN,`${e}`)}get autoplay(){return WS(this,LS.AUTOPLAY)!=null}set autoplay(e){e?this.setAttribute(LS.AUTOPLAY,typeof e==`string`?e:``):this.removeAttribute(LS.AUTOPLAY)}get loop(){return WS(this,LS.LOOP)!=null}set loop(e){e?this.setAttribute(LS.LOOP,``):this.removeAttribute(LS.LOOP)}get muted(){return this.media?.muted??!1}set muted(e){this.media&&(this.media.muted=!!e)}get defaultMuted(){return WS(this,LS.MUTED)!=null}set defaultMuted(e){e?this.setAttribute(LS.MUTED,``):this.removeAttribute(LS.MUTED)}get playsInline(){return WS(this,LS.PLAYSINLINE)!=null}set playsInline(e){FS(`playsInline is set to true by default and is not currently supported as a setter.`)}get preload(){return this.media?this.media.preload:this.getAttribute(`preload`)}set preload(e){[``,`none`,`metadata`,`auto`].includes(e)?this.setAttribute(LS.PRELOAD,e):this.removeAttribute(LS.PRELOAD)}};function WS(e,t){return e.media?e.media.getAttribute(t):e.getAttribute(t)}var GS=US,KS=`:host {
  --media-control-display: var(--controls);
  --media-loading-indicator-display: var(--loading-indicator);
  --media-dialog-display: var(--dialog);
  --media-play-button-display: var(--play-button);
  --media-live-button-display: var(--live-button);
  --media-seek-backward-button-display: var(--seek-backward-button);
  --media-seek-forward-button-display: var(--seek-forward-button);
  --media-mute-button-display: var(--mute-button);
  --media-captions-button-display: var(--captions-button);
  --media-captions-menu-button-display: var(--captions-menu-button, var(--media-captions-button-display));
  --media-rendition-menu-button-display: var(--rendition-menu-button);
  --media-audio-track-menu-button-display: var(--audio-track-menu-button);
  --media-airplay-button-display: var(--airplay-button);
  --media-pip-button-display: var(--pip-button);
  --media-fullscreen-button-display: var(--fullscreen-button);
  --media-cast-button-display: var(--cast-button, var(--_cast-button-drm-display));
  --media-playback-rate-button-display: var(--playback-rate-button);
  --media-playback-rate-menu-button-display: var(--playback-rate-menu-button);
  --media-volume-range-display: var(--volume-range);
  --media-time-range-display: var(--time-range);
  --media-time-display-display: var(--time-display);
  --media-duration-display-display: var(--duration-display);
  --media-title-display-display: var(--title-display);

  display: inline-block;
  line-height: 0;
  width: 100%;
}

a {
  color: #fff;
  font-size: 0.9em;
  text-decoration: underline;
}

media-theme {
  display: inline-block;
  line-height: 0;
  width: 100%;
  height: 100%;
  direction: ltr;
}

media-poster-image {
  display: inline-block;
  line-height: 0;
  width: 100%;
  height: 100%;
}

media-poster-image:not([src]):not([placeholdersrc]) {
  display: none;
}

::part(top),
[part~='top'] {
  --media-control-display: var(--controls, var(--top-controls));
  --media-play-button-display: var(--play-button, var(--top-play-button));
  --media-live-button-display: var(--live-button, var(--top-live-button));
  --media-seek-backward-button-display: var(--seek-backward-button, var(--top-seek-backward-button));
  --media-seek-forward-button-display: var(--seek-forward-button, var(--top-seek-forward-button));
  --media-mute-button-display: var(--mute-button, var(--top-mute-button));
  --media-captions-button-display: var(--captions-button, var(--top-captions-button));
  --media-captions-menu-button-display: var(
    --captions-menu-button,
    var(--media-captions-button-display, var(--top-captions-menu-button))
  );
  --media-rendition-menu-button-display: var(--rendition-menu-button, var(--top-rendition-menu-button));
  --media-audio-track-menu-button-display: var(--audio-track-menu-button, var(--top-audio-track-menu-button));
  --media-airplay-button-display: var(--airplay-button, var(--top-airplay-button));
  --media-pip-button-display: var(--pip-button, var(--top-pip-button));
  --media-fullscreen-button-display: var(--fullscreen-button, var(--top-fullscreen-button));
  --media-cast-button-display: var(--cast-button, var(--top-cast-button, var(--_cast-button-drm-display)));
  --media-playback-rate-button-display: var(--playback-rate-button, var(--top-playback-rate-button));
  --media-playback-rate-menu-button-display: var(
    --captions-menu-button,
    var(--media-playback-rate-button-display, var(--top-playback-rate-menu-button))
  );
  --media-volume-range-display: var(--volume-range, var(--top-volume-range));
  --media-time-range-display: var(--time-range, var(--top-time-range));
  --media-time-display-display: var(--time-display, var(--top-time-display));
  --media-duration-display-display: var(--duration-display, var(--top-duration-display));
  --media-title-display-display: var(--title-display, var(--top-title-display));
}

::part(center),
[part~='center'] {
  --media-control-display: var(--controls, var(--center-controls));
  --media-play-button-display: var(--play-button, var(--center-play-button));
  --media-live-button-display: var(--live-button, var(--center-live-button));
  --media-seek-backward-button-display: var(--seek-backward-button, var(--center-seek-backward-button));
  --media-seek-forward-button-display: var(--seek-forward-button, var(--center-seek-forward-button));
  --media-mute-button-display: var(--mute-button, var(--center-mute-button));
  --media-captions-button-display: var(--captions-button, var(--center-captions-button));
  --media-captions-menu-button-display: var(
    --captions-menu-button,
    var(--media-captions-button-display, var(--center-captions-menu-button))
  );
  --media-rendition-menu-button-display: var(--rendition-menu-button, var(--center-rendition-menu-button));
  --media-audio-track-menu-button-display: var(--audio-track-menu-button, var(--center-audio-track-menu-button));
  --media-airplay-button-display: var(--airplay-button, var(--center-airplay-button));
  --media-pip-button-display: var(--pip-button, var(--center-pip-button));
  --media-fullscreen-button-display: var(--fullscreen-button, var(--center-fullscreen-button));
  --media-cast-button-display: var(--cast-button, var(--center-cast-button, var(--_cast-button-drm-display)));
  --media-playback-rate-button-display: var(--playback-rate-button, var(--center-playback-rate-button));
  --media-playback-rate-menu-button-display: var(
    --playback-rate-menu-button,
    var(--media-playback-rate-button-display, var(--center-playback-rate-menu-button))
  );
  --media-volume-range-display: var(--volume-range, var(--center-volume-range));
  --media-time-range-display: var(--time-range, var(--center-time-range));
  --media-time-display-display: var(--time-display, var(--center-time-display));
  --media-duration-display-display: var(--duration-display, var(--center-duration-display));
}

::part(bottom),
[part~='bottom'] {
  --media-control-display: var(--controls, var(--bottom-controls));
  --media-play-button-display: var(--play-button, var(--bottom-play-button));
  --media-live-button-display: var(--live-button, var(--bottom-live-button));
  --media-seek-backward-button-display: var(--seek-backward-button, var(--bottom-seek-backward-button));
  --media-seek-forward-button-display: var(--seek-forward-button, var(--bottom-seek-forward-button));
  --media-mute-button-display: var(--mute-button, var(--bottom-mute-button));
  --media-captions-button-display: var(--captions-button, var(--bottom-captions-button));
  --media-captions-menu-button-display: var(
    --captions-menu-button,
    var(--media-captions-button-display, var(--bottom-captions-menu-button))
  );
  --media-rendition-menu-button-display: var(--rendition-menu-button, var(--bottom-rendition-menu-button));
  --media-audio-track-menu-button-display: var(--audio-track-menu-button, var(--bottom-audio-track-menu-button));
  --media-airplay-button-display: var(--airplay-button, var(--bottom-airplay-button));
  --media-pip-button-display: var(--pip-button, var(--bottom-pip-button));
  --media-fullscreen-button-display: var(--fullscreen-button, var(--bottom-fullscreen-button));
  --media-cast-button-display: var(--cast-button, var(--bottom-cast-button, var(--_cast-button-drm-display)));
  --media-playback-rate-button-display: var(--playback-rate-button, var(--bottom-playback-rate-button));
  --media-playback-rate-menu-button-display: var(
    --playback-rate-menu-button,
    var(--media-playback-rate-button-display, var(--bottom-playback-rate-menu-button))
  );
  --media-volume-range-display: var(--volume-range, var(--bottom-volume-range));
  --media-time-range-display: var(--time-range, var(--bottom-time-range));
  --media-time-display-display: var(--time-display, var(--bottom-time-display));
  --media-duration-display-display: var(--duration-display, var(--bottom-duration-display));
  --media-title-display-display: var(--title-display, var(--bottom-title-display));
}

:host([no-tooltips]) {
  --media-tooltip-display: none;
}
`,qS=new WeakMap,JS=class e{constructor(e,t){this.element=e,this.type=t,this.element.addEventListener(this.type,this);let n=qS.get(this.element);n&&n.set(this.type,this)}set(e){if(typeof e==`function`)this.handleEvent=e.bind(this.element);else if(typeof e==`object`&&typeof e.handleEvent==`function`)this.handleEvent=e.handleEvent.bind(e);else{this.element.removeEventListener(this.type,this);let e=qS.get(this.element);e&&e.delete(this.type)}}static for(t){qS.has(t.element)||qS.set(t.element,new Map);let n=t.attributeName.slice(2),r=qS.get(t.element);return r&&r.has(n)?r.get(n):new e(t.element,n)}};function YS(e,t){return e instanceof z_&&e.attributeName.startsWith(`on`)?(JS.for(e).set(t),e.element.removeAttributeNS(e.attributeNamespace,e.attributeName),!0):!1}function XS(e,t){return t instanceof oC&&e instanceof B_&&(t.renderInto(e),!0)}function ZS(e,t){return t instanceof DocumentFragment&&e instanceof B_&&(t.childNodes.length&&e.replace(...t.childNodes),!0)}function QS(e,t){if(e instanceof z_){let n=e.attributeNamespace,r=e.element.getAttributeNS(n,e.attributeName);return String(t)!==r&&(e.value=String(t)),!0}return e.value=String(t),!0}function $S(e,t){if(e instanceof z_&&t instanceof Element){let n=e.element;return n[e.attributeName]!==t&&(e.element.removeAttributeNS(e.attributeNamespace,e.attributeName),n[e.attributeName]=t),!0}return!1}function eC(e,t){if(typeof t==`boolean`&&e instanceof z_){let n=e.attributeNamespace;return t!==e.element.hasAttributeNS(n,e.attributeName)&&(e.booleanValue=t),!0}return!1}function tC(e,t){return t===!1&&e instanceof B_&&(e.replace(``),!0)}function nC(e,t){$S(e,t)||eC(e,t)||YS(e,t)||tC(e,t)||XS(e,t)||ZS(e,t)||QS(e,t)}var rC=new Map,iC=new WeakMap,aC=new WeakMap,oC=class{constructor(e,t,n){this.strings=e,this.values=t,this.processor=n,this.stringsKey=this.strings.join(``)}get template(){if(rC.has(this.stringsKey))return rC.get(this.stringsKey);{let e=fS.createElement(`template`),t=this.strings.length-1;return e.innerHTML=this.strings.reduce((e,n,r)=>e+n+(r<t?`{{ ${r} }}`:``),``),rC.set(this.stringsKey,e),e}}renderInto(e){var t;let n=this.template;if(iC.get(e)!==n){iC.set(e,n);let t=new j_(n,this.values,this.processor);aC.set(e,t),e instanceof B_?e.replace(...t.children):e.appendChild(t);return}let r=aC.get(e);(t=r?.update)==null||t.call(r,this.values)}},sC={processCallback(e,t,n){if(n)for(let[e,r]of t)e in n&&nC(r,n[e]??``)}};function cC(e,...t){return new oC(e,t,sC)}function lC(e,t){e.renderInto(t)}var uC=e=>{let{tokens:t}=e;return t.drm?`:host(:not([cast-receiver])) { --_cast-button-drm-display: none; }`:``},dC=e=>cC`
  <style>
    ${uC(e)}
    ${KS}
  </style>
  ${mC(e)}
`,fC=e=>{let t=e.hotKeys?`${e.hotKeys}`:``;return ES(e.streamType)===`live`&&(t+=` noarrowleft noarrowright`),t},pC=Object.values({TOP:`top`,CENTER:`center`,BOTTOM:`bottom`,LAYER:`layer`,MEDIA_LAYER:`media-layer`,POSTER_LAYER:`poster-layer`,VERTICAL_LAYER:`vertical-layer`,CENTERED_LAYER:`centered-layer`,GESTURE_LAYER:`gesture-layer`,CONTROLLER_LAYER:`controller`,BUTTON:`button`,RANGE:`range`,THUMB:`thumb`,DISPLAY:`display`,CONTROL_BAR:`control-bar`,MENU_BUTTON:`menu-button`,MENU:`menu`,MENU_ITEM:`menu-item`,OPTION:`option`,POSTER:`poster`,LIVE:`live`,PLAY:`play`,PRE_PLAY:`pre-play`,SEEK_BACKWARD:`seek-backward`,SEEK_FORWARD:`seek-forward`,MUTE:`mute`,CAPTIONS:`captions`,AIRPLAY:`airplay`,PIP:`pip`,FULLSCREEN:`fullscreen`,CAST:`cast`,PLAYBACK_RATE:`playback-rate`,VOLUME:`volume`,TIME:`time`,TITLE:`title`,AUDIO_TRACK:`audio-track`,RENDITION:`rendition`}).join(`, `),mC=e=>{var t;return cC`
  <media-theme
    template="${e.themeTemplate||!1}"
    defaultstreamtype="${e.defaultStreamType??!1}"
    hotkeys="${fC(e)||!1}"
    nohotkeys="${e.noHotKeys||!e.hasSrc||!1}"
    noautoseektolive="${!!((t=e.streamType)!=null&&t.includes(w.LIVE))&&e.targetLiveWindow!==0}"
    novolumepref="${e.novolumepref||!1}"
    nomutedpref="${e.nomutedpref||!1}"
    disabled="${!e.hasSrc||e.isDialogOpen}"
    audio="${e.audio??!1}"
    style="${mS({"--media-primary-color":e.primaryColor,"--media-secondary-color":e.secondaryColor,"--media-accent-color":e.accentColor})??!1}"
    defaultsubtitles="${!e.defaultHiddenCaptions}"
    forwardseekoffset="${e.forwardSeekOffset??!1}"
    backwardseekoffset="${e.backwardSeekOffset??!1}"
    playbackrates="${e.playbackRates??!1}"
    defaultshowremainingtime="${e.defaultShowRemainingTime??!1}"
    defaultduration="${e.defaultDuration??!1}"
    hideduration="${e.hideDuration??!1}"
    title="${e.title??!1}"
    videotitle="${e.videoTitle??!1}"
    proudlydisplaymuxbadge="${e.proudlyDisplayMuxBadge??!1}"
    exportparts="${pC}"
  >
    <mux-video
      slot="media"
      inert="${e.noHotKeys??!1}"
      target-live-window="${e.targetLiveWindow??!1}"
      stream-type="${ES(e.streamType)??!1}"
      crossorigin="${e.crossOrigin??``}"
      playsinline
      autoplay="${e.autoplay??!1}"
      muted="${e.muted??!1}"
      loop="${e.loop??!1}"
      preload="${e.preload??!1}"
      debug="${e.debug??!1}"
      prefer-cmcd="${e.preferCmcd??!1}"
      disable-tracking="${e.disableTracking??!1}"
      disable-cookies="${e.disableCookies??!1}"
      prefer-playback="${e.preferPlayback??!1}"
      start-time="${e.startTime!=null&&e.startTime}"
      initial-bandwidth-estimate-kbps="${e.initialBandwidthEstimateKbps!=null&&e.initialBandwidthEstimateKbps}"
      initial-estimate-segments="${e.initialEstimateSegments!=null&&e.initialEstimateSegments}"
      min-preload-segments="${e.minPreloadSegments!=null&&e.minPreloadSegments}"
      beacon-collection-domain="${e.beaconCollectionDomain??!1}"
      player-init-time="${e.playerInitTime??!1}"
      player-software-name="${e.playerSoftwareName??!1}"
      player-software-version="${e.playerSoftwareVersion??!1}"
      env-key="${e.envKey??!1}"
      custom-domain="${e.customDomain??!1}"
      src="${e.src?e.src:e.playbackId?ma(e):!1}"
      cast-src="${e.src?e.src:e.playbackId?ma(e):!1}"
      cast-receiver="${e.castReceiver??!1}"
      drm-token="${e.tokens?.drm??!1}"
      playback-token="${e.tokens?.playback??!1}"
      exportparts="video"
      disable-pseudo-ended="${e.disablePseudoEnded??!1}"
      max-reconnect-retries="${e.maxReconnectRetries??!1}"
      max-auto-resolution="${e.maxAutoResolution??!1}"
      cap-rendition-to-player-size="${e.capRenditionToPlayerSize??!1}"
    >
      ${e.storyboard?cC`<track label="thumbnails" default kind="metadata" src="${e.storyboard}" />`:cC``}
      <slot></slot>
    </mux-video>
    <slot name="poster" slot="poster">
      <media-poster-image
        part="poster"
        exportparts="poster, img"
        src="${e.poster?e.poster:!1}"
        placeholdersrc="${e.placeholder??!1}"
      ></media-poster-image>
    </slot>
  </media-theme>
`},hC=e=>e.charAt(0).toUpperCase()+e.slice(1),gC=(e,t=!1)=>{if(e.muxCode){let n=hC(e.errorCategory??`video`),r=nr(e.errorCategory??x.VIDEO);if(e.muxCode===S.NETWORK_OFFLINE)return E(`Your device appears to be offline`,t);if(e.muxCode===S.NETWORK_RECONNECTING)return E(`Reconnecting...`,t);if(e.muxCode===S.NETWORK_TOKEN_EXPIRED)return E(`{category} URL has expired`,t).format({category:n});if([S.NETWORK_TOKEN_SUB_MISMATCH,S.NETWORK_TOKEN_AUD_MISMATCH,S.NETWORK_TOKEN_AUD_MISSING,S.NETWORK_TOKEN_MALFORMED].includes(e.muxCode))return E(`{category} URL is formatted incorrectly`,t).format({category:n});if(e.muxCode===S.NETWORK_TOKEN_MISSING)return E(`Invalid {categoryName} URL`,t).format({categoryName:r});if(e.muxCode===S.NETWORK_NOT_FOUND)return E(`{category} does not exist`,t).format({category:n});if(e.muxCode===S.NETWORK_NOT_READY){let n=e.streamType===`live`?`Live stream`:`Video`;return E(`{mediaType} is not currently available`,t).format({mediaType:n})}}if(e.code){if(e.code===C.MEDIA_ERR_NETWORK)return E(`Network Error`,t);if(e.code===C.MEDIA_ERR_DECODE)return E(`Media Error`,t);if(e.code===C.MEDIA_ERR_SRC_NOT_SUPPORTED)return E(`Source Not Supported`,t)}return E(`Error`,t)},_C=(e,t=!1)=>{if(e.reload)return``;if(e.muxCode){let n=hC(e.errorCategory??`video`),r=nr(e.errorCategory??x.VIDEO);return e.muxCode===S.NETWORK_OFFLINE?E(`Check your internet connection and try reloading this video.`,t):e.muxCode===S.NETWORK_RECONNECTING?E(`Your connection was interrupted. Attempting to resume playback...`,t):e.muxCode===S.NETWORK_TOKEN_EXPIRED?E(`The video’s secured {tokenNamePrefix}-token has expired.`,t).format({tokenNamePrefix:r}):e.muxCode===S.NETWORK_TOKEN_SUB_MISMATCH?E(`The video’s playback ID does not match the one encoded in the {tokenNamePrefix}-token.`,t).format({tokenNamePrefix:r}):e.muxCode===S.NETWORK_TOKEN_MALFORMED?E(`{category} URL is formatted incorrectly`,t).format({category:n}):[S.NETWORK_TOKEN_AUD_MISMATCH,S.NETWORK_TOKEN_AUD_MISSING].includes(e.muxCode)?E(`The {tokenNamePrefix}-token is formatted with incorrect information.`,t).format({tokenNamePrefix:r}):[S.NETWORK_TOKEN_MISSING,S.NETWORK_INVALID_URL].includes(e.muxCode)?E(`The video URL or {tokenNamePrefix}-token are formatted with incorrect or incomplete information.`,t).format({tokenNamePrefix:r}):e.muxCode===S.NETWORK_NOT_FOUND?``:e.message}return e.code&&(e.code===C.MEDIA_ERR_NETWORK||e.code===C.MEDIA_ERR_DECODE||(e.code,C.MEDIA_ERR_SRC_NOT_SUPPORTED)),e.message},vC=(e,t=!1)=>({title:gC(e,t).toString(),message:_C(e,t).toString(),reload:!!e.reload}),yC=e=>{if(e.muxCode){if(e.muxCode===S.NETWORK_TOKEN_EXPIRED)return`403-expired-token.md`;if(e.muxCode===S.NETWORK_TOKEN_MALFORMED)return`403-malformatted-token.md`;if([S.NETWORK_TOKEN_AUD_MISMATCH,S.NETWORK_TOKEN_AUD_MISSING].includes(e.muxCode))return`403-incorrect-aud-value.md`;if(e.muxCode===S.NETWORK_TOKEN_SUB_MISMATCH)return`403-playback-id-mismatch.md`;if(e.muxCode===S.NETWORK_TOKEN_MISSING)return`missing-signed-tokens.md`;if(e.muxCode===S.NETWORK_NOT_FOUND)return`404-not-found.md`;if(e.muxCode===S.NETWORK_NOT_READY)return`412-not-playable.md`}if(e.code){if(e.code===C.MEDIA_ERR_NETWORK)return``;if(e.code===C.MEDIA_ERR_DECODE)return`media-decode-error.md`;if(e.code===C.MEDIA_ERR_SRC_NOT_SUPPORTED)return`media-src-not-supported.md`}return``},bC=(e,t)=>{let n=yC(e);return{message:e.message,context:e.context,file:n}},xC=`<template id="media-theme-gerwig">
  <style>
    @keyframes pre-play-hide {
      0% {
        transform: scale(1);
        opacity: 1;
      }

      30% {
        transform: scale(0.7);
      }

      100% {
        transform: scale(1.5);
        opacity: 0;
      }
    }

    :host {
      --_primary-color: var(--media-primary-color, #fff);
      --_secondary-color: var(--media-secondary-color, transparent);
      --_accent-color: var(--media-accent-color, #fa50b5);
      --_text-color: var(--media-text-color, #000);

      --media-icon-color: var(--_primary-color);
      --media-control-background: var(--_secondary-color);
      --media-control-hover-background: var(--_accent-color);
      --media-time-buffered-color: rgba(255, 255, 255, 0.4);
      --media-preview-time-text-shadow: none;
      --media-control-height: 14px;
      --media-control-padding: 6px;
      --media-tooltip-container-margin: 6px;
      --media-tooltip-distance: 18px;

      color: var(--_primary-color);
      display: inline-block;
      width: 100%;
      height: 100%;
    }

    :host([audio]) {
      --_secondary-color: var(--media-secondary-color, black);
      --media-preview-time-text-shadow: none;
    }

    :host([audio]) ::slotted([slot='media']) {
      height: 0px;
    }

    :host([audio]) media-loading-indicator {
      display: none;
    }

    :host([audio]) media-controller {
      background: transparent;
    }

    :host([audio]) media-controller::part(vertical-layer) {
      background: transparent;
    }

    :host([audio]) media-control-bar {
      width: 100%;
      background-color: var(--media-control-background);
    }

    /*
     * 0.433s is the transition duration for VTT Regions.
     * Borrowed here, so the captions don't move too fast.
     */
    media-controller {
      --media-webkit-text-track-transform: translateY(0) scale(0.98);
      --media-webkit-text-track-transition: transform 0.433s ease-out 0.3s;
    }
    media-controller:is([mediapaused], :not([userinactive])) {
      --media-webkit-text-track-transform: translateY(-50px) scale(0.98);
      --media-webkit-text-track-transition: transform 0.15s ease;
    }

    /*
     * CSS specific to iOS devices.
     * See: https://stackoverflow.com/questions/30102792/css-media-query-to-target-only-ios-devices/60220757#60220757
     */
    @supports (-webkit-touch-callout: none) {
      /* Disable subtitle adjusting for iOS Safari */
      media-controller[mediaisfullscreen] {
        --media-webkit-text-track-transform: unset;
        --media-webkit-text-track-transition: unset;
      }
    }

    media-time-range {
      --media-box-padding-left: 6px;
      --media-box-padding-right: 6px;
      --media-range-bar-color: var(--_accent-color);
      --media-time-range-buffered-color: var(--_primary-color);
      --media-range-track-color: transparent;
      --media-range-track-background: rgba(255, 255, 255, 0.4);
      --media-range-thumb-background: radial-gradient(
        circle,
        #000 0%,
        #000 25%,
        var(--_accent-color) 25%,
        var(--_accent-color)
      );
      --media-range-thumb-width: 12px;
      --media-range-thumb-height: 12px;
      --media-range-thumb-transform: scale(0);
      --media-range-thumb-transition: transform 0.3s;
      --media-range-thumb-opacity: 1;
      --media-preview-background: var(--_primary-color);
      --media-box-arrow-background: var(--_primary-color);
      --media-preview-thumbnail-border: 5px solid var(--_primary-color);
      --media-preview-border-radius: 5px;
      --media-text-color: var(--_text-color);
      --media-control-hover-background: transparent;
      --media-preview-chapter-text-shadow: none;
      color: var(--_accent-color);
      padding: 0 6px;
    }

    :host([audio]) media-time-range {
      --media-preview-time-padding: 1.5px 6px;
      --media-preview-box-margin: 0 0 -5px;
    }

    media-time-range:hover {
      --media-range-thumb-transform: scale(1);
    }

    media-preview-thumbnail {
      border-bottom-width: 0;
    }

    [part~='menu'] {
      border-radius: 2px;
      border: 1px solid rgba(0, 0, 0, 0.1);
      bottom: 50px;
      padding: 2.5px 10px;
    }

    [part~='menu']::part(indicator) {
      fill: var(--_accent-color);
    }

    [part~='menu']::part(menu-item) {
      box-sizing: border-box;
      display: flex;
      align-items: center;
      padding: 6px 10px;
      min-height: 34px;
    }

    [part~='menu']::part(checked) {
      font-weight: 700;
    }

    media-captions-menu,
    media-rendition-menu,
    media-audio-track-menu,
    media-playback-rate-menu {
      position: absolute; /* ensure they don't take up space in DOM on load */
      --media-menu-background: var(--_primary-color);
      --media-menu-item-checked-background: transparent;
      --media-text-color: var(--_text-color);
      --media-menu-item-hover-background: transparent;
      --media-menu-item-hover-outline: var(--_accent-color) solid 1px;
    }

    media-rendition-menu {
      min-width: 140px;
    }

    /* The icon is a circle so make it 16px high instead of 14px for more balance. */
    media-audio-track-menu-button {
      --media-control-padding: 5px;
      --media-control-height: 16px;
    }

    media-playback-rate-menu-button {
      --media-control-padding: 6px 3px;
      min-width: 4.4ch;
    }

    media-playback-rate-menu {
      --media-menu-flex-direction: row;
      --media-menu-item-checked-background: var(--_accent-color);
      --media-menu-item-checked-indicator-display: none;
      margin-right: 6px;
      padding: 0;
      --media-menu-gap: 0.25em;
    }

    media-playback-rate-menu[part~='menu']::part(menu-item) {
      padding: 6px 6px 6px 8px;
    }

    media-playback-rate-menu[part~='menu']::part(checked) {
      color: #fff;
    }

    :host(:not([audio])) media-time-range {
      /* Adding px is required here for calc() */
      --media-range-padding: 0px;
      background: transparent;
      z-index: 10;
      height: 10px;
      bottom: -3px;
      width: 100%;
    }

    media-control-bar :is([role='button'], [role='switch'], button) {
      line-height: 0;
    }

    media-control-bar :is([part*='button'], [part*='range'], [part*='display']) {
      border-radius: 3px;
    }

    .spacer {
      flex-grow: 1;
      background-color: var(--media-control-background, rgba(20, 20, 30, 0.7));
    }

    media-control-bar[slot~='top-chrome'] {
      min-height: 42px;
      pointer-events: none;
    }

    media-control-bar {
      --gradient-steps:
        hsl(0 0% 0% / 0) 0%, hsl(0 0% 0% / 0.013) 8.1%, hsl(0 0% 0% / 0.049) 15.5%, hsl(0 0% 0% / 0.104) 22.5%,
        hsl(0 0% 0% / 0.175) 29%, hsl(0 0% 0% / 0.259) 35.3%, hsl(0 0% 0% / 0.352) 41.2%, hsl(0 0% 0% / 0.45) 47.1%,
        hsl(0 0% 0% / 0.55) 52.9%, hsl(0 0% 0% / 0.648) 58.8%, hsl(0 0% 0% / 0.741) 64.7%, hsl(0 0% 0% / 0.825) 71%,
        hsl(0 0% 0% / 0.896) 77.5%, hsl(0 0% 0% / 0.951) 84.5%, hsl(0 0% 0% / 0.987) 91.9%, hsl(0 0% 0%) 100%;
    }

    :host([title]) media-control-bar[slot='top-chrome']::before,
    :host([videotitle]) media-control-bar[slot='top-chrome']::before {
      content: '';
      position: absolute;
      width: 100%;
      padding-bottom: min(100px, 25%);
      background: linear-gradient(to top, var(--gradient-steps));
      opacity: 0.8;
      pointer-events: none;
    }

    :host(:not([audio])) media-control-bar[part~='bottom']::before {
      content: '';
      position: absolute;
      width: 100%;
      bottom: 0;
      left: 0;
      padding-bottom: min(100px, 25%);
      background: linear-gradient(to bottom, var(--gradient-steps));
      opacity: 0.8;
      z-index: 1;
      pointer-events: none;
    }

    media-control-bar[part~='bottom'] > * {
      z-index: 20;
    }

    media-control-bar[part~='bottom'] {
      padding: 6px 6px;
    }

    media-control-bar[slot~='top-chrome'] > * {
      --media-control-background: transparent;
      --media-control-hover-background: transparent;
      position: relative;
    }

    media-controller::part(vertical-layer) {
      transition: background-color 1s;
    }

    media-controller:is([mediapaused], :not([userinactive]))::part(vertical-layer) {
      background-color: var(--controls-backdrop-color, var(--controls, transparent));
      transition: background-color 0.25s;
    }

    .center-controls {
      --media-button-icon-width: 100%;
      --media-button-icon-height: auto;
      --media-tooltip-display: none;
      pointer-events: none;
      width: 100%;
      display: flex;
      flex-flow: row;
      align-items: center;
      justify-content: center;
      paint-order: stroke;
      stroke: rgba(102, 102, 102, 1);
      stroke-width: 0.3px;
      text-shadow:
        0 0 2px rgb(0 0 0 / 0.25),
        0 0 6px rgb(0 0 0 / 0.25);
      filter: drop-shadow(0 0 2px rgb(0 0 0 / 0.25)) drop-shadow(0 0 6px rgb(0 0 0 / 0.25));
    }

    .center-controls media-play-button {
      --media-control-background: transparent;
      --media-control-hover-background: transparent;
      --media-control-padding: 0;
      width: 40px;
    }

    [breakpointsm] .center-controls media-play-button {
      width: 90px;
      height: 90px;
      border-radius: 50%;
      transition: background 0.4s;
      padding: 24px;
      --media-control-background: #000;
      --media-control-hover-background: var(--_accent-color);
    }

    .center-controls media-seek-backward-button,
    .center-controls media-seek-forward-button {
      --media-control-background: transparent;
      --media-control-hover-background: transparent;
      padding: 0;
      margin: 0 20px;
      width: max(33px, min(8%, 40px));
      text-shadow:
        0 0 2px rgb(0 0 0 / 0.25),
        0 0 6px rgb(0 0 0 / 0.25);
    }

    [breakpointsm]:not([audio]) .center-controls.pre-playback {
      display: grid;
      align-items: initial;
      justify-content: initial;
      height: 100%;
      overflow: hidden;
    }

    [breakpointsm]:not([audio]) .center-controls.pre-playback media-play-button {
      place-self: var(--_pre-playback-place, center);
      grid-area: 1 / 1;
      margin: 16px;
    }

    /* Show and hide controls or pre-playback state */

    [breakpointsm]:is([mediahasplayed], :not([mediapaused])):not([audio])
      .center-controls.pre-playback
      media-play-button {
      /* Using \`forwards\` would lead to a laggy UI after the animation got in the end state */
      animation: 0.3s linear pre-play-hide;
      opacity: 0;
      pointer-events: none;
    }

    .autoplay-unmute {
      --media-control-hover-background: transparent;
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      filter: drop-shadow(0 0 2px rgb(0 0 0 / 0.25)) drop-shadow(0 0 6px rgb(0 0 0 / 0.25));
    }

    .autoplay-unmute-btn {
      --media-control-height: 16px;
      border-radius: 8px;
      background: #000;
      color: var(--_primary-color);
      display: flex;
      align-items: center;
      padding: 8px 16px;
      font-size: 18px;
      font-weight: 500;
      cursor: pointer;
    }

    .autoplay-unmute-btn:hover {
      background: var(--_accent-color);
    }

    [breakpointsm] .autoplay-unmute-btn {
      --media-control-height: 30px;
      padding: 14px 24px;
      font-size: 26px;
    }

    .autoplay-unmute-btn svg {
      margin: 0 6px 0 0;
    }

    [breakpointsm] .autoplay-unmute-btn svg {
      margin: 0 10px 0 0;
    }

    media-controller:not([audio]):not([mediahasplayed]) *:is(media-control-bar, media-time-range) {
      display: none;
    }

    media-error-dialog:not([mediaerrorcode]) {
      opacity: 0;
    }

    media-loading-indicator {
      --media-loading-icon-width: 100%;
      --media-button-icon-height: auto;
      display: var(--media-control-display, var(--media-loading-indicator-display, flex));
      pointer-events: none;
      position: absolute;
      width: min(15%, 150px);
      flex-flow: row;
      align-items: center;
      justify-content: center;
    }

    /* Intentionally don't target the div for transition but the children
     of the div. Prevents messing with media-chrome's autohide feature. */
    media-loading-indicator + div * {
      transition: opacity 0.15s;
      opacity: 1;
    }

    media-loading-indicator[medialoading]:not([mediapaused]) ~ div > * {
      opacity: 0;
      transition-delay: 400ms;
    }

    media-volume-range {
      width: min(100%, 100px);
      --media-range-padding-left: 10px;
      --media-range-padding-right: 10px;
      --media-range-thumb-width: 12px;
      --media-range-thumb-height: 12px;
      --media-range-thumb-background: radial-gradient(
        circle,
        #000 0%,
        #000 25%,
        var(--_primary-color) 25%,
        var(--_primary-color)
      );
      --media-control-hover-background: none;
    }

    media-time-display {
      white-space: nowrap;
    }

    /* Generic style for explicitly disabled controls */
    media-control-bar[part~='bottom'] [disabled],
    media-control-bar[part~='bottom'] [aria-disabled='true'] {
      opacity: 60%;
      cursor: not-allowed;
    }

    media-text-display {
      --media-font-size: 16px;
      --media-control-padding: 14px;
      font-weight: 500;
    }

    media-play-button.animated *:is(g, path) {
      transition: all 0.3s;
    }

    media-play-button.animated[mediapaused] .pause-icon-pt1 {
      opacity: 0;
    }

    media-play-button.animated[mediapaused] .pause-icon-pt2 {
      transform-origin: center center;
      transform: scaleY(0);
    }

    media-play-button.animated[mediapaused] .play-icon {
      clip-path: inset(0 0 0 0);
    }

    media-play-button.animated:not([mediapaused]) .play-icon {
      clip-path: inset(0 0 0 100%);
    }

    media-seek-forward-button,
    media-seek-backward-button {
      --media-font-weight: 400;
    }

    .mute-icon {
      display: inline-block;
    }

    .mute-icon :is(path, g) {
      transition: opacity 0.5s;
    }

    .muted {
      opacity: 0;
    }

    media-mute-button[mediavolumelevel='low'] :is(.volume-medium, .volume-high),
    media-mute-button[mediavolumelevel='medium'] :is(.volume-high) {
      opacity: 0;
    }

    media-mute-button[mediavolumelevel='off'] .unmuted {
      opacity: 0;
    }

    media-mute-button[mediavolumelevel='off'] .muted {
      opacity: 1;
    }

    /**
     * Our defaults for these buttons are to hide them at small sizes
     * users can override this with CSS
     */
    media-controller:not([breakpointsm]):not([audio]) {
      --bottom-play-button: none;
      --bottom-seek-backward-button: none;
      --bottom-seek-forward-button: none;
      --bottom-time-display: none;
      --bottom-playback-rate-menu-button: none;
      --bottom-pip-button: none;
    }

    [part='mux-badge'] {
      position: absolute;
      bottom: 10px;
      right: 10px;
      z-index: 2;
      opacity: 0.6;
      transition:
        opacity 0.2s ease-in-out,
        bottom 0.2s ease-in-out;
    }

    [part='mux-badge']:hover {
      opacity: 1;
    }

    [part='mux-badge'] a {
      font-size: 14px;
      font-family: var(--_font-family);
      color: var(--_primary-color);
      text-decoration: none;
      display: flex;
      align-items: center;
      gap: 5px;
    }

    [part='mux-badge'] .mux-badge-text {
      transition: opacity 0.5s ease-in-out;
      opacity: 0;
    }

    [part='mux-badge'] .mux-badge-logo {
      width: 40px;
      height: auto;
      display: inline-block;
    }

    [part='mux-badge'] .mux-badge-logo svg {
      width: 100%;
      height: 100%;
      fill: white;
    }

    media-controller:not([userinactive]):not([mediahasplayed]) [part='mux-badge'],
    media-controller:not([userinactive]) [part='mux-badge'],
    media-controller[mediahasplayed][mediapaused] [part='mux-badge'] {
      transition: bottom 0.1s ease-in-out;
    }

    media-controller[userinactive]:not([mediapaused]) [part='mux-badge'] {
      transition: bottom 0.2s ease-in-out 0.62s;
    }

    media-controller:not([userinactive]) [part='mux-badge'] .mux-badge-text,
    media-controller[mediahasplayed][mediapaused] [part='mux-badge'] .mux-badge-text {
      opacity: 1;
    }

    media-controller[userinactive]:not([mediapaused]) [part='mux-badge'] .mux-badge-text {
      opacity: 0;
    }

    media-controller[userinactive]:not([mediapaused]) [part='mux-badge'] {
      bottom: 10px;
    }

    media-controller:not([userinactive]):not([mediahasplayed]) [part='mux-badge'] {
      bottom: 10px;
    }

    media-controller:not([userinactive])[mediahasplayed] [part='mux-badge'],
    media-controller[mediahasplayed][mediapaused] [part='mux-badge'] {
      bottom: calc(28px + var(--media-control-height, 0px) + var(--media-control-padding, 0px) * 2);
    }
  </style>

  <template partial="TitleDisplay">
    <template if="videotitle">
      <template if="videotitle != true">
        <media-text-display part="top title display" class="title-display">{{videotitle}}</media-text-display>
      </template>
    </template>
    <template if="!videotitle">
      <template if="title">
        <media-text-display part="top title display" class="title-display">{{title}}</media-text-display>
      </template>
    </template>
  </template>

  <template partial="PlayButton">
    <media-play-button
      part="{{section ?? 'bottom'}} play button"
      disabled="{{disabled}}"
      aria-disabled="{{disabled}}"
      class="animated"
    >
      <svg aria-hidden="true" viewBox="0 0 18 14" slot="icon">
        <g class="play-icon">
          <path
            d="M15.5987 6.2911L3.45577 0.110898C2.83667 -0.204202 2.06287 0.189698 2.06287 0.819798V13.1802C2.06287 13.8103 2.83667 14.2042 3.45577 13.8891L15.5987 7.7089C16.2178 7.3938 16.2178 6.6061 15.5987 6.2911Z"
          />
        </g>
        <g class="pause-icon">
          <path
            class="pause-icon-pt1"
            d="M5.90709 0H2.96889C2.46857 0 2.06299 0.405585 2.06299 0.9059V13.0941C2.06299 13.5944 2.46857 14 2.96889 14H5.90709C6.4074 14 6.81299 13.5944 6.81299 13.0941V0.9059C6.81299 0.405585 6.4074 0 5.90709 0Z"
          />
          <path
            class="pause-icon-pt2"
            d="M15.1571 0H12.2189C11.7186 0 11.313 0.405585 11.313 0.9059V13.0941C11.313 13.5944 11.7186 14 12.2189 14H15.1571C15.6574 14 16.063 13.5944 16.063 13.0941V0.9059C16.063 0.405585 15.6574 0 15.1571 0Z"
          />
        </g>
      </svg>
    </media-play-button>
  </template>

  <template partial="PrePlayButton">
    <media-play-button
      part="{{section ?? 'center'}} play button pre-play"
      disabled="{{disabled}}"
      aria-disabled="{{disabled}}"
    >
      <svg aria-hidden="true" viewBox="0 0 18 14" slot="icon" style="transform: translate(3px, 0)">
        <path
          d="M15.5987 6.2911L3.45577 0.110898C2.83667 -0.204202 2.06287 0.189698 2.06287 0.819798V13.1802C2.06287 13.8103 2.83667 14.2042 3.45577 13.8891L15.5987 7.7089C16.2178 7.3938 16.2178 6.6061 15.5987 6.2911Z"
        />
      </svg>
    </media-play-button>
  </template>

  <template partial="SeekBackwardButton">
    <media-seek-backward-button
      seekoffset="{{backwardseekoffset}}"
      part="{{section ?? 'bottom'}} seek-backward button"
      disabled="{{disabled}}"
      aria-disabled="{{disabled}}"
    >
      <svg viewBox="0 0 22 14" aria-hidden="true" slot="icon">
        <path
          d="M3.65 2.07888L0.0864 6.7279C-0.0288 6.87812 -0.0288 7.12188 0.0864 7.2721L3.65 11.9211C3.7792 12.0896 4 11.9703 4 11.7321V2.26787C4 2.02968 3.7792 1.9104 3.65 2.07888Z"
        />
        <text transform="translate(6 12)" style="font-size: 14px; font-family: 'ArialMT', 'Arial'">
          {{backwardseekoffset}}
        </text>
      </svg>
    </media-seek-backward-button>
  </template>

  <template partial="SeekForwardButton">
    <media-seek-forward-button
      seekoffset="{{forwardseekoffset}}"
      part="{{section ?? 'bottom'}} seek-forward button"
      disabled="{{disabled}}"
      aria-disabled="{{disabled}}"
    >
      <svg viewBox="0 0 22 14" aria-hidden="true" slot="icon">
        <g>
          <text transform="translate(-1 12)" style="font-size: 14px; font-family: 'ArialMT', 'Arial'">
            {{forwardseekoffset}}
          </text>
          <path
            d="M18.35 11.9211L21.9136 7.2721C22.0288 7.12188 22.0288 6.87812 21.9136 6.7279L18.35 2.07888C18.2208 1.91041 18 2.02968 18 2.26787V11.7321C18 11.9703 18.2208 12.0896 18.35 11.9211Z"
          />
        </g>
      </svg>
    </media-seek-forward-button>
  </template>

  <template partial="MuteButton">
    <media-mute-button part="bottom mute button" disabled="{{disabled}}" aria-disabled="{{disabled}}">
      <svg viewBox="0 0 18 14" slot="icon" class="mute-icon" aria-hidden="true">
        <g class="unmuted">
          <path
            d="M6.76786 1.21233L3.98606 3.98924H1.19937C0.593146 3.98924 0.101743 4.51375 0.101743 5.1607V6.96412L0 6.99998L0.101743 7.03583V8.83926C0.101743 9.48633 0.593146 10.0108 1.19937 10.0108H3.98606L6.76773 12.7877C7.23561 13.2547 8 12.9007 8 12.2171V1.78301C8 1.09925 7.23574 0.745258 6.76786 1.21233Z"
          />
          <path
            class="volume-low"
            d="M10 3.54781C10.7452 4.55141 11.1393 5.74511 11.1393 6.99991C11.1393 8.25471 10.7453 9.44791 10 10.4515L10.7988 11.0496C11.6734 9.87201 12.1356 8.47161 12.1356 6.99991C12.1356 5.52821 11.6735 4.12731 10.7988 2.94971L10 3.54781Z"
          />
          <path
            class="volume-medium"
            d="M12.3778 2.40086C13.2709 3.76756 13.7428 5.35806 13.7428 7.00026C13.7428 8.64246 13.2709 10.233 12.3778 11.5992L13.2106 12.1484C14.2107 10.6185 14.739 8.83796 14.739 7.00016C14.739 5.16236 14.2107 3.38236 13.2106 1.85156L12.3778 2.40086Z"
          />
          <path
            class="volume-high"
            d="M15.5981 0.75L14.7478 1.2719C15.7937 2.9919 16.3468 4.9723 16.3468 7C16.3468 9.0277 15.7937 11.0082 14.7478 12.7281L15.5981 13.25C16.7398 11.3722 17.343 9.211 17.343 7C17.343 4.789 16.7398 2.6268 15.5981 0.75Z"
          />
        </g>
        <g class="muted">
          <path
            fill-rule="evenodd"
            clip-rule="evenodd"
            d="M4.39976 4.98924H1.19937C1.19429 4.98924 1.17777 4.98961 1.15296 5.01609C1.1271 5.04369 1.10174 5.09245 1.10174 5.1607V8.83926C1.10174 8.90761 1.12714 8.95641 1.15299 8.984C1.17779 9.01047 1.1943 9.01084 1.19937 9.01084H4.39977L7 11.6066V2.39357L4.39976 4.98924ZM7.47434 1.92006C7.4743 1.9201 7.47439 1.92002 7.47434 1.92006V1.92006ZM6.76773 12.7877L3.98606 10.0108H1.19937C0.593146 10.0108 0.101743 9.48633 0.101743 8.83926V7.03583L0 6.99998L0.101743 6.96412V5.1607C0.101743 4.51375 0.593146 3.98924 1.19937 3.98924H3.98606L6.76786 1.21233C7.23574 0.745258 8 1.09925 8 1.78301V12.2171C8 12.9007 7.23561 13.2547 6.76773 12.7877Z"
          />
          <path
            fill-rule="evenodd"
            clip-rule="evenodd"
            d="M15.2677 9.30323C15.463 9.49849 15.7796 9.49849 15.9749 9.30323C16.1701 9.10796 16.1701 8.79138 15.9749 8.59612L14.2071 6.82841L15.9749 5.06066C16.1702 4.8654 16.1702 4.54882 15.9749 4.35355C15.7796 4.15829 15.4631 4.15829 15.2678 4.35355L13.5 6.1213L11.7322 4.35348C11.537 4.15822 11.2204 4.15822 11.0251 4.35348C10.8298 4.54874 10.8298 4.86532 11.0251 5.06058L12.7929 6.82841L11.0251 8.59619C10.8299 8.79146 10.8299 9.10804 11.0251 9.3033C11.2204 9.49856 11.537 9.49856 11.7323 9.3033L13.5 7.53552L15.2677 9.30323Z"
          />
        </g>
      </svg>
    </media-mute-button>
  </template>

  <template partial="PipButton">
    <media-pip-button part="bottom pip button" disabled="{{disabled}}" aria-disabled="{{disabled}}">
      <svg viewBox="0 0 18 14" aria-hidden="true" slot="icon">
        <path
          d="M15.9891 0H2.011C0.9004 0 0 0.9003 0 2.0109V11.989C0 13.0996 0.9004 14 2.011 14H15.9891C17.0997 14 18 13.0997 18 11.9891V2.0109C18 0.9003 17.0997 0 15.9891 0ZM17 11.9891C17 12.5465 16.5465 13 15.9891 13H2.011C1.4536 13 1.0001 12.5465 1.0001 11.9891V2.0109C1.0001 1.4535 1.4536 0.9999 2.011 0.9999H15.9891C16.5465 0.9999 17 1.4535 17 2.0109V11.9891Z"
        />
        <path
          d="M15.356 5.67822H8.19523C8.03253 5.67822 7.90063 5.81012 7.90063 5.97282V11.3836C7.90063 11.5463 8.03253 11.6782 8.19523 11.6782H15.356C15.5187 11.6782 15.6506 11.5463 15.6506 11.3836V5.97282C15.6506 5.81012 15.5187 5.67822 15.356 5.67822Z"
        />
      </svg>
    </media-pip-button>
  </template>

  <template partial="CaptionsMenu">
    <media-captions-menu-button part="bottom captions button">
      <svg aria-hidden="true" viewBox="0 0 18 14" slot="on">
        <path
          d="M15.989 0H2.011C0.9004 0 0 0.9003 0 2.0109V11.9891C0 13.0997 0.9004 14 2.011 14H15.989C17.0997 14 18 13.0997 18 11.9891V2.0109C18 0.9003 17.0997 0 15.989 0ZM4.2292 8.7639C4.5954 9.1902 5.0935 9.4031 5.7233 9.4031C6.1852 9.4031 6.5544 9.301 6.8302 9.0969C7.1061 8.8933 7.2863 8.614 7.3702 8.26H8.4322C8.3062 8.884 8.0093 9.3733 7.5411 9.7273C7.0733 10.0813 6.4703 10.2581 5.732 10.2581C5.108 10.2581 4.5699 10.1219 4.1168 9.8489C3.6637 9.5759 3.3141 9.1946 3.0685 8.7058C2.8224 8.2165 2.6994 7.6511 2.6994 7.009C2.6994 6.3611 2.8224 5.7927 3.0685 5.3034C3.3141 4.8146 3.6637 4.4323 4.1168 4.1559C4.5699 3.88 5.108 3.7418 5.732 3.7418C6.4703 3.7418 7.0733 3.922 7.5411 4.2818C8.0094 4.6422 8.3062 5.1461 8.4322 5.794H7.3702C7.2862 5.4283 7.106 5.1368 6.8302 4.921C6.5544 4.7052 6.1852 4.5968 5.7233 4.5968C5.0934 4.5968 4.5954 4.8116 4.2292 5.2404C3.8635 5.6696 3.6804 6.259 3.6804 7.009C3.6804 7.7531 3.8635 8.3381 4.2292 8.7639ZM11.0974 8.7639C11.4636 9.1902 11.9617 9.4031 12.5915 9.4031C13.0534 9.4031 13.4226 9.301 13.6984 9.0969C13.9743 8.8933 14.1545 8.614 14.2384 8.26H15.3004C15.1744 8.884 14.8775 9.3733 14.4093 9.7273C13.9415 10.0813 13.3385 10.2581 12.6002 10.2581C11.9762 10.2581 11.4381 10.1219 10.985 9.8489C10.5319 9.5759 10.1823 9.1946 9.9367 8.7058C9.6906 8.2165 9.5676 7.6511 9.5676 7.009C9.5676 6.3611 9.6906 5.7927 9.9367 5.3034C10.1823 4.8146 10.5319 4.4323 10.985 4.1559C11.4381 3.88 11.9762 3.7418 12.6002 3.7418C13.3385 3.7418 13.9415 3.922 14.4093 4.2818C14.8776 4.6422 15.1744 5.1461 15.3004 5.794H14.2384C14.1544 5.4283 13.9742 5.1368 13.6984 4.921C13.4226 4.7052 13.0534 4.5968 12.5915 4.5968C11.9616 4.5968 11.4636 4.8116 11.0974 5.2404C10.7317 5.6696 10.5486 6.259 10.5486 7.009C10.5486 7.7531 10.7317 8.3381 11.0974 8.7639Z"
        />
      </svg>
      <svg aria-hidden="true" viewBox="0 0 18 14" slot="off">
        <path
          d="M5.73219 10.258C5.10819 10.258 4.57009 10.1218 4.11699 9.8488C3.66389 9.5758 3.31429 9.1945 3.06869 8.7057C2.82259 8.2164 2.69958 7.651 2.69958 7.0089C2.69958 6.361 2.82259 5.7926 3.06869 5.3033C3.31429 4.8145 3.66389 4.4322 4.11699 4.1558C4.57009 3.8799 5.10819 3.7417 5.73219 3.7417C6.47049 3.7417 7.07348 3.9219 7.54128 4.2817C8.00958 4.6421 8.30638 5.146 8.43238 5.7939H7.37039C7.28639 5.4282 7.10618 5.1367 6.83039 4.9209C6.55459 4.7051 6.18538 4.5967 5.72348 4.5967C5.09358 4.5967 4.59559 4.8115 4.22939 5.2403C3.86369 5.6695 3.68058 6.2589 3.68058 7.0089C3.68058 7.753 3.86369 8.338 4.22939 8.7638C4.59559 9.1901 5.09368 9.403 5.72348 9.403C6.18538 9.403 6.55459 9.3009 6.83039 9.0968C7.10629 8.8932 7.28649 8.6139 7.37039 8.2599H8.43238C8.30638 8.8839 8.00948 9.3732 7.54128 9.7272C7.07348 10.0812 6.47049 10.258 5.73219 10.258Z"
        />
        <path
          d="M12.6003 10.258C11.9763 10.258 11.4382 10.1218 10.9851 9.8488C10.532 9.5758 10.1824 9.1945 9.93685 8.7057C9.69075 8.2164 9.56775 7.651 9.56775 7.0089C9.56775 6.361 9.69075 5.7926 9.93685 5.3033C10.1824 4.8145 10.532 4.4322 10.9851 4.1558C11.4382 3.8799 11.9763 3.7417 12.6003 3.7417C13.3386 3.7417 13.9416 3.9219 14.4094 4.2817C14.8777 4.6421 15.1745 5.146 15.3005 5.7939H14.2385C14.1545 5.4282 13.9743 5.1367 13.6985 4.9209C13.4227 4.7051 13.0535 4.5967 12.5916 4.5967C11.9617 4.5967 11.4637 4.8115 11.0975 5.2403C10.7318 5.6695 10.5487 6.2589 10.5487 7.0089C10.5487 7.753 10.7318 8.338 11.0975 8.7638C11.4637 9.1901 11.9618 9.403 12.5916 9.403C13.0535 9.403 13.4227 9.3009 13.6985 9.0968C13.9744 8.8932 14.1546 8.6139 14.2385 8.2599H15.3005C15.1745 8.8839 14.8776 9.3732 14.4094 9.7272C13.9416 10.0812 13.3386 10.258 12.6003 10.258Z"
        />
        <path
          d="M15.9891 1C16.5465 1 17 1.4535 17 2.011V11.9891C17 12.5465 16.5465 13 15.9891 13H2.0109C1.4535 13 1 12.5465 1 11.9891V2.0109C1 1.4535 1.4535 0.9999 2.0109 0.9999L15.9891 1ZM15.9891 0H2.0109C0.9003 0 0 0.9003 0 2.0109V11.9891C0 13.0997 0.9003 14 2.0109 14H15.9891C17.0997 14 18 13.0997 18 11.9891V2.0109C18 0.9003 17.0997 0 15.9891 0Z"
        />
      </svg>
    </media-captions-menu-button>
    <media-captions-menu
      hidden
      anchor="auto"
      part="bottom captions menu"
      disabled="{{disabled}}"
      aria-disabled="{{disabled}}"
      exportparts="menu-item"
    >
      <div slot="checked-indicator">
        <style>
          .indicator {
            position: relative;
            top: 1px;
            width: 0.9em;
            height: auto;
            fill: var(--_accent-color);
            margin-right: 5px;
          }

          [aria-checked='false'] .indicator {
            display: none;
          }
        </style>
        <svg viewBox="0 0 14 18" class="indicator">
          <path
            d="M12.252 3.48c-.115.033-.301.161-.425.291-.059.063-1.407 1.815-2.995 3.894s-2.897 3.79-2.908 3.802c-.013.014-.661-.616-1.672-1.624-.908-.905-1.702-1.681-1.765-1.723-.401-.27-.783-.211-1.176.183a1.285 1.285 0 0 0-.261.342.582.582 0 0 0-.082.35c0 .165.01.205.08.35.075.153.213.296 2.182 2.271 1.156 1.159 2.17 2.159 2.253 2.222.189.143.338.196.539.194.203-.003.412-.104.618-.299.205-.193 6.7-8.693 6.804-8.903a.716.716 0 0 0 .085-.345c.01-.179.005-.203-.062-.339-.124-.252-.45-.531-.746-.639a.784.784 0 0 0-.469-.027"
            fill-rule="evenodd"
          />
        </svg></div
    ></media-captions-menu>
  </template>

  <template partial="AirplayButton">
    <media-airplay-button part="bottom airplay button" disabled="{{disabled}}" aria-disabled="{{disabled}}">
      <svg viewBox="0 0 18 14" aria-hidden="true" slot="icon">
        <path
          d="M16.1383 0H1.8618C0.8335 0 0 0.8335 0 1.8617V10.1382C0 11.1664 0.8335 12 1.8618 12H3.076C3.1204 11.9433 3.1503 11.8785 3.2012 11.826L4.004 11H1.8618C1.3866 11 1 10.6134 1 10.1382V1.8617C1 1.3865 1.3866 0.9999 1.8618 0.9999H16.1383C16.6135 0.9999 17.0001 1.3865 17.0001 1.8617V10.1382C17.0001 10.6134 16.6135 11 16.1383 11H13.9961L14.7989 11.826C14.8499 11.8785 14.8798 11.9432 14.9241 12H16.1383C17.1665 12 18.0001 11.1664 18.0001 10.1382V1.8617C18 0.8335 17.1665 0 16.1383 0Z"
        />
        <path
          d="M9.55061 8.21903C9.39981 8.06383 9.20001 7.98633 9.00011 7.98633C8.80021 7.98633 8.60031 8.06383 8.44951 8.21903L4.09771 12.697C3.62471 13.1838 3.96961 13.9998 4.64831 13.9998H13.3518C14.0304 13.9998 14.3754 13.1838 13.9023 12.697L9.55061 8.21903Z"
        />
      </svg>
    </media-airplay-button>
  </template>

  <template partial="FullscreenButton">
    <media-fullscreen-button part="bottom fullscreen button" disabled="{{disabled}}" aria-disabled="{{disabled}}">
      <svg viewBox="0 0 18 14" aria-hidden="true" slot="enter">
        <path
          d="M1.00745 4.39539L1.01445 1.98789C1.01605 1.43049 1.47085 0.978289 2.02835 0.979989L6.39375 0.992589L6.39665 -0.007411L2.03125 -0.020011C0.920646 -0.023211 0.0176463 0.874489 0.0144463 1.98509L0.00744629 4.39539H1.00745Z"
        />
        <path
          d="M17.0144 2.03431L17.0076 4.39541H18.0076L18.0144 2.03721C18.0176 0.926712 17.1199 0.0237125 16.0093 0.0205125L11.6439 0.0078125L11.641 1.00781L16.0064 1.02041C16.5638 1.02201 17.016 1.47681 17.0144 2.03431Z"
        />
        <path
          d="M16.9925 9.60498L16.9855 12.0124C16.9839 12.5698 16.5291 13.022 15.9717 13.0204L11.6063 13.0078L11.6034 14.0078L15.9688 14.0204C17.0794 14.0236 17.9823 13.1259 17.9855 12.0153L17.9925 9.60498H16.9925Z"
        />
        <path
          d="M0.985626 11.9661L0.992426 9.60498H-0.0074737L-0.0142737 11.9632C-0.0174737 13.0738 0.880226 13.9767 1.99083 13.98L6.35623 13.9926L6.35913 12.9926L1.99373 12.98C1.43633 12.9784 0.983926 12.5236 0.985626 11.9661Z"
        />
      </svg>
      <svg viewBox="0 0 18 14" aria-hidden="true" slot="exit">
        <path
          d="M5.39655 -0.0200195L5.38955 2.38748C5.38795 2.94488 4.93315 3.39708 4.37565 3.39538L0.0103463 3.38278L0.00744629 4.38278L4.37285 4.39538C5.48345 4.39858 6.38635 3.50088 6.38965 2.39028L6.39665 -0.0200195H5.39655Z"
        />
        <path
          d="M12.6411 2.36891L12.6479 0.0078125H11.6479L11.6411 2.36601C11.6379 3.47651 12.5356 4.37951 13.6462 4.38271L18.0116 4.39531L18.0145 3.39531L13.6491 3.38271C13.0917 3.38111 12.6395 2.92641 12.6411 2.36891Z"
        />
        <path
          d="M12.6034 14.0204L12.6104 11.613C12.612 11.0556 13.0668 10.6034 13.6242 10.605L17.9896 10.6176L17.9925 9.61759L13.6271 9.60499C12.5165 9.60179 11.6136 10.4995 11.6104 11.6101L11.6034 14.0204H12.6034Z"
        />
        <path
          d="M5.359 11.6315L5.3522 13.9926H6.3522L6.359 11.6344C6.3622 10.5238 5.4645 9.62088 4.3539 9.61758L-0.0115043 9.60498L-0.0144043 10.605L4.351 10.6176C4.9084 10.6192 5.3607 11.074 5.359 11.6315Z"
        />
      </svg>
    </media-fullscreen-button>
  </template>

  <template partial="CastButton">
    <media-cast-button part="bottom cast button" disabled="{{disabled}}" aria-disabled="{{disabled}}">
      <svg viewBox="0 0 18 14" aria-hidden="true" slot="enter">
        <path
          d="M16.0072 0H2.0291C0.9185 0 0.0181 0.9003 0.0181 2.011V5.5009C0.357 5.5016 0.6895 5.5275 1.0181 5.5669V2.011C1.0181 1.4536 1.4716 1 2.029 1H16.0072C16.5646 1 17.0181 1.4536 17.0181 2.011V11.9891C17.0181 12.5465 16.5646 13 16.0072 13H8.4358C8.4746 13.3286 8.4999 13.6611 8.4999 13.9999H16.0071C17.1177 13.9999 18.018 13.0996 18.018 11.989V2.011C18.0181 0.9003 17.1178 0 16.0072 0ZM0 6.4999V7.4999C3.584 7.4999 6.5 10.4159 6.5 13.9999H7.5C7.5 9.8642 4.1357 6.4999 0 6.4999ZM0 8.7499V9.7499C2.3433 9.7499 4.25 11.6566 4.25 13.9999H5.25C5.25 11.1049 2.895 8.7499 0 8.7499ZM0.0181 11V14H3.0181C3.0181 12.3431 1.675 11 0.0181 11Z"
        />
      </svg>
      <svg viewBox="0 0 18 14" aria-hidden="true" slot="exit">
        <path
          d="M15.9891 0H2.01103C0.900434 0 3.35947e-05 0.9003 3.35947e-05 2.011V5.5009C0.338934 5.5016 0.671434 5.5275 1.00003 5.5669V2.011C1.00003 1.4536 1.45353 1 2.01093 1H15.9891C16.5465 1 17 1.4536 17 2.011V11.9891C17 12.5465 16.5465 13 15.9891 13H8.41773C8.45653 13.3286 8.48183 13.6611 8.48183 13.9999H15.989C17.0996 13.9999 17.9999 13.0996 17.9999 11.989V2.011C18 0.9003 17.0997 0 15.9891 0ZM-0.0180664 6.4999V7.4999C3.56593 7.4999 6.48193 10.4159 6.48193 13.9999H7.48193C7.48193 9.8642 4.11763 6.4999 -0.0180664 6.4999ZM-0.0180664 8.7499V9.7499C2.32523 9.7499 4.23193 11.6566 4.23193 13.9999H5.23193C5.23193 11.1049 2.87693 8.7499 -0.0180664 8.7499ZM3.35947e-05 11V14H3.00003C3.00003 12.3431 1.65693 11 3.35947e-05 11Z"
        />
        <path d="M2.15002 5.634C5.18352 6.4207 7.57252 8.8151 8.35282 11.8499H15.8501V2.1499H2.15002V5.634Z" />
      </svg>
    </media-cast-button>
  </template>

  <template partial="LiveButton">
    <media-live-button part="{{section ?? 'top'}} live button" disabled="{{disabled}}" aria-disabled="{{disabled}}">
      <span slot="text">Live</span>
    </media-live-button>
  </template>

  <template partial="PlaybackRateMenu">
    <media-playback-rate-menu-button part="bottom playback-rate button"></media-playback-rate-menu-button>
    <media-playback-rate-menu
      hidden
      anchor="auto"
      rates="{{playbackrates}}"
      exportparts="menu-item"
      part="bottom playback-rate menu"
      disabled="{{disabled}}"
      aria-disabled="{{disabled}}"
    ></media-playback-rate-menu>
  </template>

  <template partial="VolumeRange">
    <media-volume-range
      part="bottom volume range"
      disabled="{{disabled}}"
      aria-disabled="{{disabled}}"
    ></media-volume-range>
  </template>

  <template partial="TimeDisplay">
    <media-time-display
      remaining="{{defaultshowremainingtime}}"
      showduration="{{!hideduration}}"
      part="bottom time display"
      disabled="{{disabled}}"
      aria-disabled="{{disabled}}"
    ></media-time-display>
  </template>

  <template partial="TimeRange">
    <media-time-range part="bottom time range" disabled="{{disabled}}" aria-disabled="{{disabled}}" exportparts="thumb">
      <media-preview-thumbnail slot="preview"></media-preview-thumbnail>
      <media-preview-chapter-display slot="preview"></media-preview-chapter-display>
      <media-preview-time-display slot="preview"></media-preview-time-display>
      <div slot="preview" part="arrow"></div>
    </media-time-range>
  </template>

  <template partial="AudioTrackMenu">
    <media-audio-track-menu-button part="bottom audio-track button">
      <svg aria-hidden="true" slot="icon" viewBox="0 0 18 16">
        <path d="M9 15A7 7 0 1 1 9 1a7 7 0 0 1 0 14Zm0 1A8 8 0 1 0 9 0a8 8 0 0 0 0 16Z" />
        <path
          d="M5.2 6.3a.5.5 0 0 1 .5.5v2.4a.5.5 0 1 1-1 0V6.8a.5.5 0 0 1 .5-.5Zm2.4-2.4a.5.5 0 0 1 .5.5v7.2a.5.5 0 0 1-1 0V4.4a.5.5 0 0 1 .5-.5ZM10 5.5a.5.5 0 0 1 .5.5v4a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5Zm2.4-.8a.5.5 0 0 1 .5.5v5.6a.5.5 0 0 1-1 0V5.2a.5.5 0 0 1 .5-.5Z"
        />
      </svg>
    </media-audio-track-menu-button>
    <media-audio-track-menu
      hidden
      anchor="auto"
      part="bottom audio-track menu"
      disabled="{{disabled}}"
      aria-disabled="{{disabled}}"
      exportparts="menu-item"
    >
      <div slot="checked-indicator">
        <style>
          .indicator {
            position: relative;
            top: 1px;
            width: 0.9em;
            height: auto;
            fill: var(--_accent-color);
            margin-right: 5px;
          }

          [aria-checked='false'] .indicator {
            display: none;
          }
        </style>
        <svg viewBox="0 0 14 18" class="indicator">
          <path
            d="M12.252 3.48c-.115.033-.301.161-.425.291-.059.063-1.407 1.815-2.995 3.894s-2.897 3.79-2.908 3.802c-.013.014-.661-.616-1.672-1.624-.908-.905-1.702-1.681-1.765-1.723-.401-.27-.783-.211-1.176.183a1.285 1.285 0 0 0-.261.342.582.582 0 0 0-.082.35c0 .165.01.205.08.35.075.153.213.296 2.182 2.271 1.156 1.159 2.17 2.159 2.253 2.222.189.143.338.196.539.194.203-.003.412-.104.618-.299.205-.193 6.7-8.693 6.804-8.903a.716.716 0 0 0 .085-.345c.01-.179.005-.203-.062-.339-.124-.252-.45-.531-.746-.639a.784.784 0 0 0-.469-.027"
            fill-rule="evenodd"
          />
        </svg>
      </div>
    </media-audio-track-menu>
  </template>

  <template partial="RenditionMenu">
    <media-rendition-menu-button part="bottom rendition button">
      <svg aria-hidden="true" slot="icon" viewBox="0 0 18 14">
        <path
          d="M2.25 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM9 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm6.75 0a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z"
        />
      </svg>
    </media-rendition-menu-button>
    <media-rendition-menu
      hidden
      anchor="auto"
      part="bottom rendition menu"
      disabled="{{disabled}}"
      aria-disabled="{{disabled}}"
    >
      <div slot="checked-indicator">
        <style>
          .indicator {
            position: relative;
            top: 1px;
            width: 0.9em;
            height: auto;
            fill: var(--_accent-color);
            margin-right: 5px;
          }

          [aria-checked='false'] .indicator {
            opacity: 0;
          }
        </style>
        <svg viewBox="0 0 14 18" class="indicator">
          <path
            d="M12.252 3.48c-.115.033-.301.161-.425.291-.059.063-1.407 1.815-2.995 3.894s-2.897 3.79-2.908 3.802c-.013.014-.661-.616-1.672-1.624-.908-.905-1.702-1.681-1.765-1.723-.401-.27-.783-.211-1.176.183a1.285 1.285 0 0 0-.261.342.582.582 0 0 0-.082.35c0 .165.01.205.08.35.075.153.213.296 2.182 2.271 1.156 1.159 2.17 2.159 2.253 2.222.189.143.338.196.539.194.203-.003.412-.104.618-.299.205-.193 6.7-8.693 6.804-8.903a.716.716 0 0 0 .085-.345c.01-.179.005-.203-.062-.339-.124-.252-.45-.531-.746-.639a.784.784 0 0 0-.469-.027"
            fill-rule="evenodd"
          />
        </svg>
      </div>
    </media-rendition-menu>
  </template>

  <template partial="MuxBadge">
    <div part="mux-badge">
      <a href="https://www.mux.com/player" target="_blank">
        <span class="mux-badge-text">Powered by</span>
        <div class="mux-badge-logo">
          <svg
            viewBox="0 0 1600 500"
            style="fill-rule: evenodd; clip-rule: evenodd; stroke-linejoin: round; stroke-miterlimit: 2"
          >
            <g>
              <path
                d="M994.287,93.486c-17.121,-0 -31,-13.879 -31,-31c0,-17.121 13.879,-31 31,-31c17.121,-0 31,13.879 31,31c0,17.121 -13.879,31 -31,31m0,-93.486c-34.509,-0 -62.484,27.976 -62.484,62.486l0,187.511c0,68.943 -56.09,125.033 -125.032,125.033c-68.942,-0 -125.03,-56.09 -125.03,-125.033l0,-187.511c0,-34.51 -27.976,-62.486 -62.485,-62.486c-34.509,-0 -62.484,27.976 -62.484,62.486l0,187.511c0,137.853 112.149,250.003 249.999,250.003c137.851,-0 250.001,-112.15 250.001,-250.003l0,-187.511c0,-34.51 -27.976,-62.486 -62.485,-62.486"
                style="fill-rule: nonzero"
              ></path>
              <path
                d="M1537.51,468.511c-17.121,-0 -31,-13.879 -31,-31c0,-17.121 13.879,-31 31,-31c17.121,-0 31,13.879 31,31c0,17.121 -13.879,31 -31,31m-275.883,-218.509l-143.33,143.329c-24.402,24.402 -24.402,63.966 0,88.368c24.402,24.402 63.967,24.402 88.369,-0l143.33,-143.329l143.328,143.329c24.402,24.4 63.967,24.402 88.369,-0c24.403,-24.402 24.403,-63.966 0.001,-88.368l-143.33,-143.329l0.001,-0.004l143.329,-143.329c24.402,-24.402 24.402,-63.965 0,-88.367c-24.402,-24.402 -63.967,-24.402 -88.369,-0l-143.329,143.328l-143.329,-143.328c-24.402,-24.401 -63.967,-24.402 -88.369,-0c-24.402,24.402 -24.402,63.965 0,88.367l143.329,143.329l0,0.004Z"
                style="fill-rule: nonzero"
              ></path>
              <path
                d="M437.511,468.521c-17.121,-0 -31,-13.879 -31,-31c0,-17.121 13.879,-31 31,-31c17.121,-0 31,13.879 31,31c0,17.121 -13.879,31 -31,31m23.915,-463.762c-23.348,-9.672 -50.226,-4.327 -68.096,13.544l-143.331,143.329l-143.33,-143.329c-17.871,-17.871 -44.747,-23.216 -68.096,-13.544c-23.349,9.671 -38.574,32.455 -38.574,57.729l0,375.026c0,34.51 27.977,62.486 62.487,62.486c34.51,-0 62.486,-27.976 62.486,-62.486l0,-224.173l80.843,80.844c24.404,24.402 63.965,24.402 88.369,-0l80.843,-80.844l0,224.173c0,34.51 27.976,62.486 62.486,62.486c34.51,-0 62.486,-27.976 62.486,-62.486l0,-375.026c0,-25.274 -15.224,-48.058 -38.573,-57.729"
                style="fill-rule: nonzero"
              ></path>
            </g>
          </svg>
        </div>
      </a>
    </div>
  </template>

  <media-controller
    part="controller"
    defaultstreamtype="{{defaultstreamtype ?? 'on-demand'}}"
    breakpoints="sm:470"
    gesturesdisabled="{{disabled}}"
    hotkeys="{{hotkeys}}"
    nohotkeys="{{nohotkeys}}"
    novolumepref="{{novolumepref}}"
    audio="{{audio}}"
    noautoseektolive="{{noautoseektolive}}"
    defaultsubtitles="{{defaultsubtitles}}"
    defaultduration="{{defaultduration ?? false}}"
    keyboardforwardseekoffset="{{forwardseekoffset}}"
    keyboardbackwardseekoffset="{{backwardseekoffset}}"
    exportparts="layer, media-layer, poster-layer, vertical-layer, centered-layer, gesture-layer"
    style="--_pre-playback-place:{{preplaybackplace ?? 'center'}}"
  >
    <slot name="media" slot="media"></slot>
    <slot name="poster" slot="poster"></slot>

    <media-loading-indicator slot="centered-chrome" noautohide></media-loading-indicator>

    <template if="!audio">
      <media-error-dialog slot="dialog" noautohide></media-error-dialog>
      <!-- Pre-playback UI -->
      <!-- same for both on-demand and live -->
      <div slot="centered-chrome" class="center-controls pre-playback">
        <template if="!breakpointsm">{{>PlayButton section="center"}}</template>
        <template if="breakpointsm">{{>PrePlayButton section="center"}}</template>
      </div>

      <!-- Mux Badge -->
      <template if="proudlydisplaymuxbadge"> {{>MuxBadge}} </template>

      <!-- Autoplay centered unmute button -->
      <!--
        todo: figure out how show this with available state variables
        needs to show when:
        - autoplay is enabled
        - playback has been successful
        - audio is muted
        - in place / instead of the pre-plaback play button
        - not to show again after user has interacted with this button
          - OR user has interacted with the mute button in the control bar
      -->
      <!--
        There should be a >MuteButton to the left of the "Unmute" text, but a templating bug
        makes it appear even if commented out in the markup, add it back when code is un-commented
      -->
      <!-- <div slot="centered-chrome" class="autoplay-unmute">
        <div role="button" class="autoplay-unmute-btn">Unmute</div>
      </div> -->

      <template if="streamtype == 'on-demand'">
        <template if="breakpointsm">
          <media-control-bar part="control-bar top" slot="top-chrome">{{>TitleDisplay}} </media-control-bar>
        </template>
        {{>TimeRange}}
        <media-control-bar part="control-bar bottom">
          {{>PlayButton}} {{>SeekBackwardButton}} {{>SeekForwardButton}} {{>TimeDisplay}} {{>MuteButton}}
          {{>VolumeRange}}
          <div class="spacer"></div>
          {{>RenditionMenu}} {{>PlaybackRateMenu}} {{>AudioTrackMenu}} {{>CaptionsMenu}} {{>AirplayButton}}
          {{>CastButton}} {{>PipButton}} {{>FullscreenButton}}
        </media-control-bar>
      </template>

      <template if="streamtype == 'live'">
        <media-control-bar part="control-bar top" slot="top-chrome">
          {{>LiveButton}}
          <template if="breakpointsm"> {{>TitleDisplay}} </template>
        </media-control-bar>
        <template if="targetlivewindow > 0">{{>TimeRange}}</template>
        <media-control-bar part="control-bar bottom">
          {{>PlayButton}}
          <template if="targetlivewindow > 0">{{>SeekBackwardButton}} {{>SeekForwardButton}}</template>
          {{>MuteButton}} {{>VolumeRange}}
          <div class="spacer"></div>
          {{>RenditionMenu}} {{>AudioTrackMenu}} {{>CaptionsMenu}} {{>AirplayButton}} {{>CastButton}} {{>PipButton}}
          {{>FullscreenButton}}
        </media-control-bar>
      </template>
    </template>

    <template if="audio">
      <template if="streamtype == 'on-demand'">
        <template if="title">
          <media-control-bar part="control-bar top">{{>TitleDisplay}}</media-control-bar>
        </template>
        <media-control-bar part="control-bar bottom">
          {{>PlayButton}}
          <template if="breakpointsm"> {{>SeekBackwardButton}} {{>SeekForwardButton}} </template>
          {{>MuteButton}}
          <template if="breakpointsm">{{>VolumeRange}}</template>
          {{>TimeDisplay}} {{>TimeRange}}
          <template if="breakpointsm">{{>PlaybackRateMenu}}</template>
          {{>AirplayButton}} {{>CastButton}}
        </media-control-bar>
      </template>

      <template if="streamtype == 'live'">
        <template if="title">
          <media-control-bar part="control-bar top">{{>TitleDisplay}}</media-control-bar>
        </template>
        <media-control-bar part="control-bar bottom">
          {{>PlayButton}} {{>LiveButton section="bottom"}} {{>MuteButton}}
          <template if="breakpointsm">
            {{>VolumeRange}}
            <template if="targetlivewindow > 0"> {{>SeekBackwardButton}} {{>SeekForwardButton}} </template>
          </template>
          <template if="targetlivewindow > 0"> {{>TimeDisplay}} {{>TimeRange}} </template>
          <template if="!targetlivewindow"><div class="spacer"></div></template>
          {{>AirplayButton}} {{>CastButton}}
        </media-control-bar>
      </template>
    </template>

    <slot></slot>
  </media-controller>
</template>
`,SC=fS.createElement(`template`);`innerHTML`in SC&&(SC.innerHTML=xC);var CC=class extends yv{};CC.template=SC.content?.children?.[0],dS.customElements.get(`media-theme-gerwig`)||dS.customElements.define(`media-theme-gerwig`,CC);var wC=`gerwig`,TC={SRC:`src`,POSTER:`poster`},Z={STYLE:`style`,DEFAULT_HIDDEN_CAPTIONS:`default-hidden-captions`,PRIMARY_COLOR:`primary-color`,SECONDARY_COLOR:`secondary-color`,ACCENT_COLOR:`accent-color`,FORWARD_SEEK_OFFSET:`forward-seek-offset`,BACKWARD_SEEK_OFFSET:`backward-seek-offset`,PLAYBACK_TOKEN:`playback-token`,THUMBNAIL_TOKEN:`thumbnail-token`,STORYBOARD_TOKEN:`storyboard-token`,FULLSCREEN_ELEMENT:`fullscreen-element`,DRM_TOKEN:`drm-token`,STORYBOARD_SRC:`storyboard-src`,THUMBNAIL_TIME:`thumbnail-time`,AUDIO:`audio`,NOHOTKEYS:`nohotkeys`,HOTKEYS:`hotkeys`,PLAYBACK_RATES:`playbackrates`,DEFAULT_SHOW_REMAINING_TIME:`default-show-remaining-time`,DEFAULT_DURATION:`default-duration`,TITLE:`title`,VIDEO_TITLE:`video-title`,PLACEHOLDER:`placeholder`,THEME:`theme`,DEFAULT_STREAM_TYPE:`default-stream-type`,TARGET_LIVE_WINDOW:`target-live-window`,EXTRA_SOURCE_PARAMS:`extra-source-params`,NO_VOLUME_PREF:`no-volume-pref`,NO_MUTED_PREF:`no-muted-pref`,CAST_RECEIVER:`cast-receiver`,NO_TOOLTIPS:`no-tooltips`,PROUDLY_DISPLAY_MUX_BADGE:`proudly-display-mux-badge`,DISABLE_PSEUDO_ENDED:`disable-pseudo-ended`},EC=[`audio`,`backwardseekoffset`,`defaultduration`,`defaultshowremainingtime`,`defaultsubtitles`,`noautoseektolive`,`disabled`,`exportparts`,`forwardseekoffset`,`hideduration`,`hotkeys`,`nohotkeys`,`playbackrates`,`defaultstreamtype`,`streamtype`,`style`,`targetlivewindow`,`template`,`title`,`videotitle`,`novolumepref`,`nomutedpref`,`proudlydisplaymuxbadge`];function DC(e,t){return{src:!e.playbackId&&e.src,playbackId:e.playbackId,hasSrc:!!e.playbackId||!!e.src||!!e.currentSrc,poster:e.poster,storyboard:e.media?.currentSrc&&e.storyboard,storyboardSrc:e.getAttribute(Z.STORYBOARD_SRC),fullscreenElement:e.getAttribute(Z.FULLSCREEN_ELEMENT),placeholder:e.getAttribute(`placeholder`),themeTemplate:kC(e),thumbnailTime:!e.tokens.thumbnail&&e.thumbnailTime,autoplay:e.autoplay,crossOrigin:e.crossOrigin,loop:e.loop,noHotKeys:e.hasAttribute(Z.NOHOTKEYS),hotKeys:e.getAttribute(Z.HOTKEYS),muted:e.muted,paused:e.paused,preload:e.preload,envKey:e.envKey,preferCmcd:e.preferCmcd,debug:e.debug,disableTracking:e.disableTracking,disableCookies:e.disableCookies,tokens:e.tokens,beaconCollectionDomain:e.beaconCollectionDomain,maxResolution:e.maxResolution,minResolution:e.minResolution,maxAutoResolution:e.maxAutoResolution,programStartTime:e.programStartTime,programEndTime:e.programEndTime,assetStartTime:e.assetStartTime,assetEndTime:e.assetEndTime,renditionOrder:e.renditionOrder,metadata:e.metadata,playerInitTime:e.playerInitTime,playerSoftwareName:e.playerSoftwareName,playerSoftwareVersion:e.playerSoftwareVersion,startTime:e.startTime,initialBandwidthEstimateKbps:e.initialBandwidthEstimateKbps,initialEstimateSegments:e.initialEstimateSegments,minPreloadSegments:e.minPreloadSegments,preferPlayback:e.preferPlayback,audio:e.audio,defaultStreamType:e.defaultStreamType,targetLiveWindow:e.getAttribute(O.TARGET_LIVE_WINDOW),streamType:ES(e.getAttribute(O.STREAM_TYPE)),primaryColor:e.getAttribute(Z.PRIMARY_COLOR),secondaryColor:e.getAttribute(Z.SECONDARY_COLOR),accentColor:e.getAttribute(Z.ACCENT_COLOR),forwardSeekOffset:e.forwardSeekOffset,backwardSeekOffset:e.backwardSeekOffset,defaultHiddenCaptions:e.defaultHiddenCaptions,defaultDuration:e.defaultDuration,defaultShowRemainingTime:e.defaultShowRemainingTime,hideDuration:AC(e),playbackRates:e.getAttribute(Z.PLAYBACK_RATES),customDomain:e.getAttribute(O.CUSTOM_DOMAIN)??void 0,title:e.getAttribute(Z.TITLE),videoTitle:e.getAttribute(Z.VIDEO_TITLE)??e.getAttribute(Z.TITLE),novolumepref:e.hasAttribute(Z.NO_VOLUME_PREF),nomutedpref:e.hasAttribute(Z.NO_MUTED_PREF),proudlyDisplayMuxBadge:e.hasAttribute(Z.PROUDLY_DISPLAY_MUX_BADGE),castReceiver:e.castReceiver,disablePseudoEnded:e.hasAttribute(Z.DISABLE_PSEUDO_ENDED),maxReconnectRetries:e.maxReconnectRetries,capRenditionToPlayerSize:e.capRenditionToPlayerSize,...t,extraSourceParams:e.extraSourceParams}}var OC=Hp.formatErrorMessage;Hp.formatErrorMessage=e=>{if(e instanceof C){let t=vC(e,!1);return t!=null&&t.reload?`
      ${t!=null&&t.title?`<h3>${pS(t.title)}</h3>`:``}
      <p>Try again later or <a href="#" data-mux-reload style="color: #4a90e2;">click here to retry</a></p>
    `:`
      ${t!=null&&t.title?`<h3>${pS(t.title)}</h3>`:``}
      ${t!=null&&t.message||t!=null&&t.linkUrl?`<p>
        ${pS(t?.message??``)}
        ${t!=null&&t.linkUrl?`<a
              href="${pS(t.linkUrl)}"
              target="_blank"
              rel="external noopener"
              aria-label="${pS(t.linkText??``)} ${E(`(opens in a new window)`)}"
              >${pS(t.linkText??t.linkUrl)}</a
            >`:``}
      </p>`:``}
    `}return OC(e)};function kC(e){var t;let n=e.theme;if(n){let r=((t=e.getRootNode())?.getElementById)?.call(t,n);if(r&&r instanceof HTMLTemplateElement)return r;n.startsWith(`media-theme-`)||(n=`media-theme-${n}`);let i=dS.customElements.get(n);if(i!=null&&i.template)return i.template}}function AC(e){let t=e.mediaController?.querySelector(`media-time-display`);return t&&getComputedStyle(t).getPropertyValue(`--media-duration-display-display`).trim()===`none`}function jC(e){let t=e.videoTitle?{video_title:e.videoTitle}:{};return e.getAttributeNames().filter(e=>e.startsWith(`metadata-`)).reduce((t,n)=>{let r=e.getAttribute(n);return r!==null&&(t[n.replace(/^metadata-/,``).replace(/-/g,`_`)]=r),t},t)}var MC=Object.values(O),NC=Object.values(TC),PC=Object.values(Z),FC=CS(),IC=`mux-player`,LC={isDialogOpen:!1},RC={redundant_streams:!0},zC,BC,VC,HC,UC,WC,GC,KC,qC,JC,YC,XC,ZC,QC,$C,Q,ew,tw,nw,rw,iw,aw,ow,sw,cw=class extends GS{constructor(){super(),$x(this,Q),$x(this,zC),$x(this,BC,!1),$x(this,VC,{}),$x(this,HC,!0),$x(this,UC,new MS(this,`hotkeys`)),$x(this,WC),$x(this,GC,()=>tS(this,Q,rw).call(this)),$x(this,KC,()=>tS(this,Q,rw).call(this)),$x(this,qC,()=>tS(this,Q,rw).call(this)),$x(this,JC,e=>{e.composedPath().find(e=>(e?.hasAttribute)?.call(e,`data-mux-reload`))&&(e.preventDefault(),window.location.reload())}),$x(this,YC,e=>{e.composedPath()[0]?.localName===`media-error-dialog`&&tS(this,Q,nw).call(this,{isDialogOpen:!1})}),$x(this,XC,e=>{e.composedPath()[0]?.localName===`media-error-dialog`&&(bS(this,fS.activeElement)||e.preventDefault())}),$x(this,ZC),$x(this,QC,{...LC}),$x(this,$C,e=>{let t=this.media?.error;if(!(t instanceof C)){let{message:e,code:n}=t??{};t=new C(e,n)}if(!(t!=null&&t.fatal)){PS(t),t.data&&PS(`${t.name} data:`,t.data);return}let n=bC(t,!1);n.message&&IS(n),FS(t),t.data&&FS(`${t.name} data:`,t.data),tS(this,Q,nw).call(this,{isDialogOpen:!0})}),eS(this,zC,fa()),this.attachShadow({mode:`open`}),tS(this,Q,tw).call(this),this.isConnected&&tS(this,Q,ew).call(this)}static get NAME(){return IC}static get VERSION(){return FC}static get observedAttributes(){return[...GS.observedAttributes??[],...NC,...MC,...PC]}setAttribute(e,t){super.setAttribute(e,t),e.startsWith(`metadata-`)&&this.media&&(this.media.metadata=jC(this))}removeAttribute(e){super.removeAttribute(e),e.startsWith(`metadata-`)&&this.media&&(this.media.metadata=jC(this))}get mediaTheme(){return this.shadowRoot?.querySelector(`media-theme`)}get mediaController(){return(this.mediaTheme?.shadowRoot)?.querySelector(`media-controller`)}connectedCallback(){tS(this,Q,ew).call(this);let e=this.media;e&&(e.metadata=jC(this))}disconnectedCallback(){var e,t,n,r,i,a,o,s;(e=X(this,WC))==null||e.disconnect(),(t=this.media)==null||t.removeEventListener(`streamtypechange`,X(this,GC)),(n=this.media)==null||n.removeEventListener(`loadstart`,X(this,KC)),this.removeEventListener(`error`,X(this,$C)),this.removeEventListener(`click`,X(this,JC)),(r=this.mediaTheme)==null||r.removeEventListener(`close`,X(this,YC)),(i=this.mediaTheme)==null||i.removeEventListener(`focusin`,X(this,XC)),this.media&&(this.media.errorTranslator=void 0),(a=this.media?.textTracks)==null||a.removeEventListener(`addtrack`,X(this,qC)),(o=this.media?.textTracks)==null||o.removeEventListener(`removetrack`,X(this,qC)),(s=X(this,ZC))==null||s.call(this),eS(this,ZC,void 0),eS(this,BC,!1)}attributeChangedCallback(e,t,n){switch(tS(this,Q,ew).call(this),super.attributeChangedCallback(e,t,n),e){case Z.HOTKEYS:X(this,UC).value=n;break;case Z.THUMBNAIL_TIME:n!=null&&this.tokens.thumbnail&&PS(E(`Use of thumbnail-time with thumbnail-token is currently unsupported. Ignore thumbnail-time.`).toString());break;case Z.THUMBNAIL_TOKEN:if(n){let e=kr(n);if(e){let{aud:t}=e,n=wi.THUMBNAIL;t!==n&&PS(E(`The {tokenNamePrefix}-token has an incorrect aud value: {aud}. aud value should be {expectedAud}.`).format({aud:t,expectedAud:n,tokenNamePrefix:`thumbnail`}))}}break;case Z.STORYBOARD_TOKEN:if(n){let e=kr(n);if(e){let{aud:t}=e,n=wi.STORYBOARD;t!==n&&PS(E(`The {tokenNamePrefix}-token has an incorrect aud value: {aud}. aud value should be {expectedAud}.`).format({aud:t,expectedAud:n,tokenNamePrefix:`storyboard`}))}}break;case Z.DRM_TOKEN:if(n){let e=kr(n);if(e){let{aud:t}=e,n=wi.DRM;t!==n&&PS(E(`The {tokenNamePrefix}-token has an incorrect aud value: {aud}. aud value should be {expectedAud}.`).format({aud:t,expectedAud:n,tokenNamePrefix:`drm`}))}}break;case O.PLAYBACK_ID:n!=null&&n.includes(`?token`)&&FS(E(`The specificed playback ID {playbackId} contains a token which must be provided via the playback-token attribute.`).format({playbackId:n}));break;case O.STREAM_TYPE:n&&![w.LIVE,w.ON_DEMAND,w.UNKNOWN].includes(n)?[`ll-live`,`live:dvr`,`ll-live:dvr`].includes(this.streamType)?this.targetLiveWindow=n.includes(`dvr`)?1/0:0:IS({file:`invalid-stream-type.md`,message:E("Invalid stream-type value supplied: `{streamType}`. Please provide stream-type as either: `on-demand` or `live`").format({streamType:this.streamType})}):n===w.LIVE?this.getAttribute(Z.TARGET_LIVE_WINDOW)??(this.targetLiveWindow=0):this.targetLiveWindow=NaN;break;case Z.FULLSCREEN_ELEMENT:if(n!=null||n!==t){let e=fS.getElementById(n),t=e?.querySelector(`mux-player`);this.mediaController&&e&&t&&(this.mediaController.fullscreenElement=e)}break;case O.CAP_RENDITION_TO_PLAYER_SIZE:(n==null||n!==t)&&(this.capRenditionToPlayerSize=n!=null||void 0);break;case O.MAX_RECONNECT_RETRIES:(n==null||n!==t)&&(this.maxReconnectRetries=Number(n))}[O.PLAYBACK_ID,TC.SRC,Z.PLAYBACK_TOKEN].includes(e)&&t!==n&&eS(this,QC,{...X(this,QC),...LC}),tS(this,Q,rw).call(this,{[OS(e)]:n})}async requestFullscreen(e){var t;if(this.mediaController&&!this.mediaController.hasAttribute(j.MEDIA_IS_FULLSCREEN))return(t=this.mediaController)==null||t.dispatchEvent(new dS.CustomEvent(k.MEDIA_ENTER_FULLSCREEN_REQUEST,{composed:!0,bubbles:!0})),new Promise((e,t)=>{var n;(n=this.mediaController)==null||n.addEventListener(Ss.MEDIA_IS_FULLSCREEN,()=>e(),{once:!0})})}async exitFullscreen(){var e;if(this.mediaController&&this.mediaController.hasAttribute(j.MEDIA_IS_FULLSCREEN))return(e=this.mediaController)==null||e.dispatchEvent(new dS.CustomEvent(k.MEDIA_EXIT_FULLSCREEN_REQUEST,{composed:!0,bubbles:!0})),new Promise((e,t)=>{var n;(n=this.mediaController)==null||n.addEventListener(Ss.MEDIA_IS_FULLSCREEN,()=>e(),{once:!0})})}get preferCmcd(){return this.getAttribute(O.PREFER_CMCD)??void 0}set preferCmcd(e){e!==this.preferCmcd&&(e?lr.includes(e)?this.setAttribute(O.PREFER_CMCD,e):PS(`Invalid value for preferCmcd. Must be one of ${lr.join()}`):this.removeAttribute(O.PREFER_CMCD))}get hasPlayed(){return this.mediaController?.hasAttribute(j.MEDIA_HAS_PLAYED)??!1}get inLiveWindow(){return this.mediaController?.hasAttribute(j.MEDIA_TIME_IS_LIVE)}get _hls(){return this.media?._hls}get mux(){return this.media?.mux}get theme(){return this.getAttribute(Z.THEME)??wC}set theme(e){this.setAttribute(Z.THEME,`${e}`)}get themeProps(){let e=this.mediaTheme;if(!e)return;let t={};for(let n of e.getAttributeNames()){if(EC.includes(n))continue;let r=e.getAttribute(n);t[gS(n)]=r===``||r}return t}set themeProps(e){var t,n;tS(this,Q,ew).call(this);let r={...this.themeProps,...e};for(let i in r){if(EC.includes(i))continue;let r=e?.[i];typeof r==`boolean`||r==null?(t=this.mediaTheme)==null||t.toggleAttribute(hS(i),!!r):(n=this.mediaTheme)==null||n.setAttribute(hS(i),r)}}get playbackId(){return this.getAttribute(O.PLAYBACK_ID)??void 0}set playbackId(e){e?this.setAttribute(O.PLAYBACK_ID,e):this.removeAttribute(O.PLAYBACK_ID)}get src(){return this.playbackId?lw(this,TC.SRC)??void 0:this.getAttribute(TC.SRC)??void 0}set src(e){e?this.setAttribute(TC.SRC,e):this.removeAttribute(TC.SRC)}get poster(){let e=this.getAttribute(TC.POSTER);if(e!=null)return e;let{tokens:t}=this;if(t.playback&&!t.thumbnail)PS(`Missing expected thumbnail token. No poster image will be shown`);else if(this.playbackId&&!this.audio)return wS(this.playbackId,{customDomain:this.customDomain,thumbnailTime:this.thumbnailTime??this.startTime,programTime:this.programStartTime,token:t.thumbnail})}set poster(e){e||e===``?this.setAttribute(TC.POSTER,e):this.removeAttribute(TC.POSTER)}get storyboardSrc(){return this.getAttribute(Z.STORYBOARD_SRC)??void 0}set storyboardSrc(e){e?this.setAttribute(Z.STORYBOARD_SRC,e):this.removeAttribute(Z.STORYBOARD_SRC)}get storyboard(){let{tokens:e}=this;if(this.storyboardSrc&&!e.storyboard)return this.storyboardSrc;if(!(this.audio||!this.playbackId||!this.streamType||[w.LIVE,w.UNKNOWN].includes(this.streamType)||e.playback&&!e.storyboard))return TS(this.playbackId,{customDomain:this.customDomain,token:e.storyboard,programStartTime:this.programStartTime,programEndTime:this.programEndTime})}get audio(){return this.hasAttribute(Z.AUDIO)}set audio(e){e?this.setAttribute(Z.AUDIO,``):this.removeAttribute(Z.AUDIO)}get hotkeys(){return X(this,UC)}get nohotkeys(){return this.hasAttribute(Z.NOHOTKEYS)}set nohotkeys(e){e?this.setAttribute(Z.NOHOTKEYS,``):this.removeAttribute(Z.NOHOTKEYS)}get thumbnailTime(){return _S(this.getAttribute(Z.THUMBNAIL_TIME))}set thumbnailTime(e){this.setAttribute(Z.THUMBNAIL_TIME,`${e}`)}get videoTitle(){return this.getAttribute(Z.VIDEO_TITLE)??this.getAttribute(Z.TITLE)??``}set videoTitle(e){e!==this.videoTitle&&(e?this.setAttribute(Z.VIDEO_TITLE,e):this.removeAttribute(Z.VIDEO_TITLE))}get placeholder(){return lw(this,Z.PLACEHOLDER)??``}set placeholder(e){this.setAttribute(Z.PLACEHOLDER,`${e}`)}get primaryColor(){let e=this.getAttribute(Z.PRIMARY_COLOR);if(e!=null||this.mediaTheme&&(e=(dS.getComputedStyle(this.mediaTheme)?.getPropertyValue(`--_primary-color`))?.trim(),e))return e}set primaryColor(e){this.setAttribute(Z.PRIMARY_COLOR,`${e}`)}get secondaryColor(){let e=this.getAttribute(Z.SECONDARY_COLOR);if(e!=null||this.mediaTheme&&(e=(dS.getComputedStyle(this.mediaTheme)?.getPropertyValue(`--_secondary-color`))?.trim(),e))return e}set secondaryColor(e){this.setAttribute(Z.SECONDARY_COLOR,`${e}`)}get accentColor(){let e=this.getAttribute(Z.ACCENT_COLOR);if(e!=null||this.mediaTheme&&(e=(dS.getComputedStyle(this.mediaTheme)?.getPropertyValue(`--_accent-color`))?.trim(),e))return e}set accentColor(e){this.setAttribute(Z.ACCENT_COLOR,`${e}`)}get defaultShowRemainingTime(){return this.hasAttribute(Z.DEFAULT_SHOW_REMAINING_TIME)}set defaultShowRemainingTime(e){e?this.setAttribute(Z.DEFAULT_SHOW_REMAINING_TIME,``):this.removeAttribute(Z.DEFAULT_SHOW_REMAINING_TIME)}get playbackRates(){if(this.hasAttribute(Z.PLAYBACK_RATES))return this.getAttribute(Z.PLAYBACK_RATES).trim().split(/\s*,?\s+/).map(e=>Number(e)).filter(e=>!Number.isNaN(e)).sort((e,t)=>e-t)}set playbackRates(e){e?this.setAttribute(Z.PLAYBACK_RATES,e.join(` `)):this.removeAttribute(Z.PLAYBACK_RATES)}get forwardSeekOffset(){return _S(this.getAttribute(Z.FORWARD_SEEK_OFFSET))??10}set forwardSeekOffset(e){this.setAttribute(Z.FORWARD_SEEK_OFFSET,`${e}`)}get backwardSeekOffset(){return _S(this.getAttribute(Z.BACKWARD_SEEK_OFFSET))??10}set backwardSeekOffset(e){this.setAttribute(Z.BACKWARD_SEEK_OFFSET,`${e}`)}get defaultHiddenCaptions(){return this.hasAttribute(Z.DEFAULT_HIDDEN_CAPTIONS)}set defaultHiddenCaptions(e){e?this.setAttribute(Z.DEFAULT_HIDDEN_CAPTIONS,``):this.removeAttribute(Z.DEFAULT_HIDDEN_CAPTIONS)}get defaultDuration(){return _S(this.getAttribute(Z.DEFAULT_DURATION))}set defaultDuration(e){e==null?this.removeAttribute(Z.DEFAULT_DURATION):this.setAttribute(Z.DEFAULT_DURATION,`${e}`)}get playerInitTime(){return this.hasAttribute(O.PLAYER_INIT_TIME)?_S(this.getAttribute(O.PLAYER_INIT_TIME)):X(this,zC)}set playerInitTime(e){e!=this.playerInitTime&&(e==null?this.removeAttribute(O.PLAYER_INIT_TIME):this.setAttribute(O.PLAYER_INIT_TIME,`${+e}`))}get playerSoftwareName(){return this.getAttribute(O.PLAYER_SOFTWARE_NAME)??IC}get playerSoftwareVersion(){return this.getAttribute(O.PLAYER_SOFTWARE_VERSION)??FC}get beaconCollectionDomain(){return this.getAttribute(O.BEACON_COLLECTION_DOMAIN)??void 0}set beaconCollectionDomain(e){e!==this.beaconCollectionDomain&&(e?this.setAttribute(O.BEACON_COLLECTION_DOMAIN,e):this.removeAttribute(O.BEACON_COLLECTION_DOMAIN))}get maxResolution(){return this.getAttribute(O.MAX_RESOLUTION)??void 0}set maxResolution(e){e!==this.maxResolution&&(e?this.setAttribute(O.MAX_RESOLUTION,e):this.removeAttribute(O.MAX_RESOLUTION))}get minResolution(){return this.getAttribute(O.MIN_RESOLUTION)??void 0}set minResolution(e){e!==this.minResolution&&(e?this.setAttribute(O.MIN_RESOLUTION,e):this.removeAttribute(O.MIN_RESOLUTION))}get maxAutoResolution(){return this.getAttribute(O.MAX_AUTO_RESOLUTION)??void 0}set maxAutoResolution(e){e==null?this.removeAttribute(O.MAX_AUTO_RESOLUTION):this.setAttribute(O.MAX_AUTO_RESOLUTION,e)}get renditionOrder(){return this.getAttribute(O.RENDITION_ORDER)??void 0}set renditionOrder(e){e!==this.renditionOrder&&(e?this.setAttribute(O.RENDITION_ORDER,e):this.removeAttribute(O.RENDITION_ORDER))}get programStartTime(){return _S(this.getAttribute(O.PROGRAM_START_TIME))}set programStartTime(e){e==null?this.removeAttribute(O.PROGRAM_START_TIME):this.setAttribute(O.PROGRAM_START_TIME,`${e}`)}get programEndTime(){return _S(this.getAttribute(O.PROGRAM_END_TIME))}set programEndTime(e){e==null?this.removeAttribute(O.PROGRAM_END_TIME):this.setAttribute(O.PROGRAM_END_TIME,`${e}`)}get assetStartTime(){return _S(this.getAttribute(O.ASSET_START_TIME))}set assetStartTime(e){e==null?this.removeAttribute(O.ASSET_START_TIME):this.setAttribute(O.ASSET_START_TIME,`${e}`)}get assetEndTime(){return _S(this.getAttribute(O.ASSET_END_TIME))}set assetEndTime(e){e==null?this.removeAttribute(O.ASSET_END_TIME):this.setAttribute(O.ASSET_END_TIME,`${e}`)}get extraSourceParams(){return this.hasAttribute(Z.EXTRA_SOURCE_PARAMS)?[...new URLSearchParams(this.getAttribute(Z.EXTRA_SOURCE_PARAMS)).entries()].reduce((e,[t,n])=>(e[t]=n,e),{}):RC}set extraSourceParams(e){e==null?this.removeAttribute(Z.EXTRA_SOURCE_PARAMS):this.setAttribute(Z.EXTRA_SOURCE_PARAMS,new URLSearchParams(e).toString())}get customDomain(){return this.getAttribute(O.CUSTOM_DOMAIN)??void 0}set customDomain(e){e!==this.customDomain&&(e?this.setAttribute(O.CUSTOM_DOMAIN,e):this.removeAttribute(O.CUSTOM_DOMAIN))}get envKey(){return lw(this,O.ENV_KEY)??void 0}set envKey(e){this.setAttribute(O.ENV_KEY,`${e}`)}get noVolumePref(){return this.hasAttribute(Z.NO_VOLUME_PREF)}set noVolumePref(e){e?this.setAttribute(Z.NO_VOLUME_PREF,``):this.removeAttribute(Z.NO_VOLUME_PREF)}get noMutedPref(){return this.hasAttribute(Z.NO_MUTED_PREF)}set noMutedPref(e){e?this.setAttribute(Z.NO_MUTED_PREF,``):this.removeAttribute(Z.NO_MUTED_PREF)}get debug(){return lw(this,O.DEBUG)!=null}set debug(e){e?this.setAttribute(O.DEBUG,``):this.removeAttribute(O.DEBUG)}get disableTracking(){return lw(this,O.DISABLE_TRACKING)!=null}set disableTracking(e){this.toggleAttribute(O.DISABLE_TRACKING,!!e)}get disableCookies(){return lw(this,O.DISABLE_COOKIES)!=null}set disableCookies(e){e?this.setAttribute(O.DISABLE_COOKIES,``):this.removeAttribute(O.DISABLE_COOKIES)}get streamType(){return this.getAttribute(O.STREAM_TYPE)??this.media?.streamType??w.UNKNOWN}set streamType(e){this.setAttribute(O.STREAM_TYPE,`${e}`)}get defaultStreamType(){return this.getAttribute(Z.DEFAULT_STREAM_TYPE)??this.mediaController?.getAttribute(Z.DEFAULT_STREAM_TYPE)??w.ON_DEMAND}set defaultStreamType(e){e?this.setAttribute(Z.DEFAULT_STREAM_TYPE,e):this.removeAttribute(Z.DEFAULT_STREAM_TYPE)}get targetLiveWindow(){return this.hasAttribute(Z.TARGET_LIVE_WINDOW)?+this.getAttribute(Z.TARGET_LIVE_WINDOW):this.media?.targetLiveWindow??NaN}set targetLiveWindow(e){e==this.targetLiveWindow||Number.isNaN(e)&&Number.isNaN(this.targetLiveWindow)||(e==null?this.removeAttribute(Z.TARGET_LIVE_WINDOW):this.setAttribute(Z.TARGET_LIVE_WINDOW,`${+e}`))}get liveEdgeStart(){return this.media?.liveEdgeStart}get startTime(){return _S(lw(this,O.START_TIME))}set startTime(e){this.setAttribute(O.START_TIME,`${e}`)}get initialBandwidthEstimateKbps(){return _S(lw(this,O.INITIAL_BANDWIDTH_ESTIMATE_KBPS))}set initialBandwidthEstimateKbps(e){e==null?this.removeAttribute(O.INITIAL_BANDWIDTH_ESTIMATE_KBPS):this.setAttribute(O.INITIAL_BANDWIDTH_ESTIMATE_KBPS,`${e}`)}get initialEstimateSegments(){return _S(lw(this,O.INITIAL_ESTIMATE_SEGMENTS))}set initialEstimateSegments(e){e==null?this.removeAttribute(O.INITIAL_ESTIMATE_SEGMENTS):this.setAttribute(O.INITIAL_ESTIMATE_SEGMENTS,`${e}`)}get minPreloadSegments(){return _S(lw(this,O.MIN_PRELOAD_SEGMENTS))}set minPreloadSegments(e){e==null?this.removeAttribute(O.MIN_PRELOAD_SEGMENTS):this.setAttribute(O.MIN_PRELOAD_SEGMENTS,`${e}`)}get preferPlayback(){let e=this.getAttribute(O.PREFER_PLAYBACK);if(e===sr.MSE||e===sr.NATIVE)return e}set preferPlayback(e){e!==this.preferPlayback&&(e===sr.MSE||e===sr.NATIVE?this.setAttribute(O.PREFER_PLAYBACK,e):this.removeAttribute(O.PREFER_PLAYBACK))}get metadata(){return this.media?.metadata}set metadata(e){tS(this,Q,ew).call(this),this.media?this.media.metadata={...jC(this),...e}:FS(`underlying media element missing when trying to set metadata. metadata will not be set.`)}get _hlsConfig(){return this.media?._hlsConfig}set _hlsConfig(e){tS(this,Q,ew).call(this),this.media?this.media._hlsConfig=e:FS(`underlying media element missing when trying to set _hlsConfig. _hlsConfig will not be set.`)}async addCuePoints(e){if(tS(this,Q,ew).call(this),!this.media)FS(`underlying media element missing when trying to addCuePoints. cuePoints will not be added.`);else return this.media?.addCuePoints(e)}get activeCuePoint(){return this.media?.activeCuePoint}get cuePoints(){return this.media?.cuePoints??[]}addChapters(e){if(tS(this,Q,ew).call(this),!this.media)FS(`underlying media element missing when trying to addChapters. chapters will not be added.`);else return this.media?.addChapters(e)}get activeChapter(){return this.media?.activeChapter}get chapters(){return this.media?.chapters??[]}getStartDate(){return this.media?.getStartDate()}get currentPdt(){return this.media?.currentPdt}get tokens(){let e=this.getAttribute(Z.PLAYBACK_TOKEN),t=this.getAttribute(Z.DRM_TOKEN),n=this.getAttribute(Z.THUMBNAIL_TOKEN),r=this.getAttribute(Z.STORYBOARD_TOKEN);return{...X(this,VC),...e==null?{}:{playback:e},...t==null?{}:{drm:t},...n==null?{}:{thumbnail:n},...r==null?{}:{storyboard:r}}}set tokens(e){eS(this,VC,e??{})}get playbackToken(){return this.getAttribute(Z.PLAYBACK_TOKEN)??void 0}set playbackToken(e){this.setAttribute(Z.PLAYBACK_TOKEN,`${e}`)}get drmToken(){return this.getAttribute(Z.DRM_TOKEN)??void 0}set drmToken(e){this.setAttribute(Z.DRM_TOKEN,`${e}`)}get thumbnailToken(){return this.getAttribute(Z.THUMBNAIL_TOKEN)??void 0}set thumbnailToken(e){this.setAttribute(Z.THUMBNAIL_TOKEN,`${e}`)}get storyboardToken(){return this.getAttribute(Z.STORYBOARD_TOKEN)??void 0}set storyboardToken(e){this.setAttribute(Z.STORYBOARD_TOKEN,`${e}`)}addTextTrack(e,t,n,r){let i=this.media?.nativeEl;if(i)return Qr(i,e,t,n,r)}removeTextTrack(e){let t=this.media?.nativeEl;if(t)return $r(t,e)}get textTracks(){return this.media?.textTracks}get castReceiver(){return this.getAttribute(Z.CAST_RECEIVER)??void 0}set castReceiver(e){e!==this.castReceiver&&(e?this.setAttribute(Z.CAST_RECEIVER,e):this.removeAttribute(Z.CAST_RECEIVER))}get castCustomData(){return this.media?.castCustomData}set castCustomData(e){this.media?this.media.castCustomData=e:FS(`underlying media element missing when trying to set castCustomData. castCustomData will not be set.`)}get noTooltips(){return this.hasAttribute(Z.NO_TOOLTIPS)}set noTooltips(e){e?this.setAttribute(Z.NO_TOOLTIPS,``):this.removeAttribute(Z.NO_TOOLTIPS)}get proudlyDisplayMuxBadge(){return this.hasAttribute(Z.PROUDLY_DISPLAY_MUX_BADGE)}set proudlyDisplayMuxBadge(e){e?this.setAttribute(Z.PROUDLY_DISPLAY_MUX_BADGE,``):this.removeAttribute(Z.PROUDLY_DISPLAY_MUX_BADGE)}get capRenditionToPlayerSize(){return this.media?.capRenditionToPlayerSize}set capRenditionToPlayerSize(e){this.media?this.media.capRenditionToPlayerSize=e:FS(`underlying media element missing when trying to set capRenditionToPlayerSize`)}get maxReconnectRetries(){return this.media?.maxReconnectRetries}set maxReconnectRetries(e){this.media?this.media.maxReconnectRetries=e:FS(`underlying media element missing when trying to set maxReconnectRetries`)}};zC=new WeakMap,BC=new WeakMap,VC=new WeakMap,HC=new WeakMap,UC=new WeakMap,WC=new WeakMap,GC=new WeakMap,KC=new WeakMap,qC=new WeakMap,JC=new WeakMap,YC=new WeakMap,XC=new WeakMap,ZC=new WeakMap,QC=new WeakMap,$C=new WeakMap,Q=new WeakSet,ew=function(){var e,t;if(!X(this,BC)){eS(this,BC,!0),tS(this,Q,rw).call(this);try{if(customElements.upgrade(this.mediaTheme),!(this.mediaTheme instanceof dS.HTMLElement))throw``}catch{FS(`<media-theme> failed to upgrade!`)}try{customElements.upgrade(this.media)}catch{FS(`underlying media element failed to upgrade!`)}try{if(customElements.upgrade(this.mediaController),!(this.mediaController instanceof zd))throw``}catch{FS(`<media-controller> failed to upgrade!`)}tS(this,Q,iw).call(this),tS(this,Q,aw).call(this),tS(this,Q,ow).call(this),eS(this,HC,this.mediaController?.hasAttribute(B.USER_INACTIVE)??!0),tS(this,Q,sw).call(this),(e=this.media)==null||e.addEventListener(`streamtypechange`,X(this,GC)),(t=this.media)==null||t.addEventListener(`loadstart`,X(this,KC)),this.media&&(this.media.metadata=jC(this))}},tw=function(){var e,t;try{(e=window==null?void 0:window.CSS)==null||e.registerProperty({name:`--media-primary-color`,syntax:`<color>`,inherits:!0}),(t=window==null?void 0:window.CSS)==null||t.registerProperty({name:`--media-secondary-color`,syntax:`<color>`,inherits:!0})}catch{}},nw=function(e){Object.assign(X(this,QC),e),tS(this,Q,rw).call(this)},rw=function(e={}){lC(dC(DC(this,{...X(this,QC),...e})),this.shadowRoot)},iw=function(){let e=e=>{var t,n;if(!(e!=null&&e.startsWith(`theme-`)))return;let r=e.replace(/^theme-/,``);if(EC.includes(r))return;let i=this.getAttribute(e);i==null?(n=this.mediaTheme)==null||n.removeAttribute(r):(t=this.mediaTheme)==null||t.setAttribute(r,i)};eS(this,WC,new MutationObserver(t=>{for(let{attributeName:n}of t)e(n)})),X(this,WC).observe(this,{attributes:!0}),this.getAttributeNames().forEach(e)},aw=function(){var e,t;this.addEventListener(`error`,X(this,$C)),this.addEventListener(`click`,X(this,JC)),(e=this.mediaTheme)==null||e.addEventListener(`close`,X(this,YC)),(t=this.mediaTheme)==null||t.addEventListener(`focusin`,X(this,XC)),this.media&&(this.media.errorTranslator=(e={})=>{if(!(this.media?.error instanceof C))return e;let t=bC(this.media?.error,!1);return{player_error_code:this.media?.error.code,player_error_message:t.message?String(t.message):e.player_error_message,player_error_context:t.context?String(t.context):e.player_error_context}})},ow=function(){var e,t;(e=this.media?.textTracks)==null||e.addEventListener(`addtrack`,X(this,qC)),(t=this.media?.textTracks)==null||t.addEventListener(`removetrack`,X(this,qC))},sw=function(){var e,t;if(!/Firefox/i.test(navigator.userAgent))return;let n,r=new WeakMap,i=()=>this.streamType===w.LIVE&&!this.secondaryColor&&this.offsetWidth>=800,a=(e,t,n=!1)=>{i()||Array.from(e&&e.activeCues||[]).forEach(e=>{if(!(!e.snapToLines||e.line<-5||e.line>=0&&e.line<10)){if(!t||this.paused){let t=e.text.split(`
`).length,i=-3;this.streamType===w.LIVE&&(i=-2);let a=i-t;if(e.line===a&&!n)return;r.has(e)||r.set(e,e.line),e.line=a}else setTimeout(()=>{e.line=r.get(e)||`auto`},500)}})},o=()=>{a(n,this.mediaController?.hasAttribute(B.USER_INACTIVE)??!1)},s=()=>{let e=Array.from(this.mediaController?.media?.textTracks||[]).filter(e=>[`subtitles`,`captions`].includes(e.kind)&&e.mode===`showing`)[0];e!==n&&n?.removeEventListener(`cuechange`,o),n=e,n?.addEventListener(`cuechange`,o),a(n,X(this,HC))};s(),(e=this.textTracks)==null||e.addEventListener(`change`,s),(t=this.textTracks)==null||t.addEventListener(`addtrack`,s);let c=()=>{let e=this.mediaController?.hasAttribute(B.USER_INACTIVE)??!0;X(this,HC)!==e&&(eS(this,HC,e),a(n,X(this,HC)))};this.addEventListener(`userinactivechange`,c),eS(this,ZC,()=>{var e,t;n?.removeEventListener(`cuechange`,o),(e=this.textTracks)==null||e.removeEventListener(`change`,s),(t=this.textTracks)==null||t.removeEventListener(`addtrack`,s),this.removeEventListener(`userinactivechange`,c)})};function lw(e,t){return e.media?e.media.getAttribute(t):e.getAttribute(t)}var uw=cw,dw=e=>{throw TypeError(e)},fw=(e,t,n)=>t.has(e)||dw(`Cannot `+n),pw=(e,t,n)=>(fw(e,t,`read from private field`),n?n.call(e):t.get(e)),mw=(e,t,n)=>t.has(e)?dw(`Cannot add the same private member more than once`):t instanceof WeakSet?t.add(e):t.set(e,n),hw=(e,t,n,r)=>(fw(e,t,`write to private field`),r?r.call(e,n):t.set(e,n),n),gw=class{addEventListener(){}removeEventListener(){}dispatchEvent(e){return!0}};if(typeof DocumentFragment>`u`){class e extends gw{}globalThis.DocumentFragment=e}var _w=class extends gw{},vw=class extends gw{},yw={get(e){},define(e,t,n){},getName(e){return null},upgrade(e){},whenDefined(e){return Promise.resolve(_w)}},bw,xw=class{constructor(e,t={}){mw(this,bw),hw(this,bw,t?.detail)}get detail(){return pw(this,bw)}initCustomEvent(){}};bw=new WeakMap;function Sw(e,t){return new _w}var Cw={document:{createElement:Sw},DocumentFragment,customElements:yw,CustomEvent:xw,EventTarget:gw,HTMLElement:_w,HTMLVideoElement:vw},ww=typeof window>`u`||globalThis.customElements===void 0,Tw=ww?Cw:globalThis;ww?Cw.document:globalThis.document,Tw.customElements.get(`mux-player`)||(Tw.customElements.define(`mux-player`,uw),Tw.MuxPlayerElement=uw);var Ew=!0,Dw={className:`class`,classname:`class`,htmlFor:`for`,crossOrigin:`crossorigin`,viewBox:`viewBox`,playsInline:`playsinline`,autoPlay:`autoplay`,playbackRate:`playbackrate`},Ow=e=>e==null,kw=(e,t)=>!Ow(t)&&e in t,Aw=e=>e.replace(/[A-Z]/g,e=>`-${e.toLowerCase()}`),jw=(e,t)=>{if(Ew||typeof t!=`boolean`||t){if(kw(e,Dw))return Dw[e];if(t!==void 0)return/[A-Z]/.test(e)?Aw(e):e}},Mw=(e,t)=>!Ew&&typeof e==`boolean`?``:e,Nw=(e={})=>{let{ref:t,...n}=e;return Object.entries(n).reduce((e,[t,n])=>{let r=jw(t,n);return r&&(e[r]=Mw(n,t)),e},{})};function Pw(e,t){if(typeof e==`function`)return e(t);e!=null&&(e.current=t)}function Fw(...e){return t=>{let n=!1,r=e.map(e=>{let r=Pw(e,t);return!n&&typeof r==`function`&&(n=!0),r});if(n)return()=>{for(let t=0;t<r.length;t++){let n=r[t];typeof n==`function`?n():Pw(e[t],null)}}}}function Iw(...e){return o.useCallback(Fw(...e),e)}var Lw=Object.prototype.hasOwnProperty,Rw=(e,t)=>{if(Object.is(e,t))return!0;if(typeof e!=`object`||!e||typeof t!=`object`||!t)return!1;if(Array.isArray(e))return!Array.isArray(t)||e.length!==t.length?!1:e.some((e,n)=>t[n]===e);let n=Object.keys(e),r=Object.keys(t);if(n.length!==r.length)return!1;for(let r=0;r<n.length;r++)if(!Lw.call(t,n[r])||!Object.is(e[n[r]],t[n[r]]))return!1;return!0},zw=(e,t,n)=>!Rw(t,e[n]),Bw=(e,t,n)=>{e[n]=t},Vw=(e,t,n,r=Bw,i=zw)=>(0,o.useEffect)(()=>{let a=n?.current;a&&i(a,t,e)&&r(a,t,e)},[n?.current,t]),Hw=(()=>{try{return`3.14.1`}catch{}return`UNKNOWN`})(),Uw=()=>Hw,$=(e,t,n)=>(0,o.useEffect)(()=>{let r=t?.current;if(!r||!n)return;let i=e,a=n;return r.addEventListener(i,a),()=>{r.removeEventListener(i,a)}},[t?.current,n,e]),Ww=o.forwardRef(({children:e,...t},n)=>o.createElement(`mux-player`,{suppressHydrationWarning:!0,...Nw(t),ref:n},e)),Gw=(e,t)=>{let{onAbort:n,onCanPlay:r,onCanPlayThrough:i,onEmptied:a,onLoadStart:o,onLoadedData:s,onLoadedMetadata:c,onProgress:l,onDurationChange:u,onVolumeChange:d,onRateChange:f,onResize:p,onWaiting:m,onPlay:h,onPlaying:ee,onTimeUpdate:te,onPause:ne,onSeeking:re,onSeeked:ie,onStalled:ae,onSuspend:oe,onEnded:se,onError:ce,onCuePointChange:le,onChapterChange:ue,metadata:de,tokens:fe,paused:pe,playbackId:me,playbackRates:he,currentTime:ge,themeProps:_e,extraSourceParams:ve,castCustomData:ye,_hlsConfig:be,...xe}=t;return Vw(`tokens`,fe,e),Vw(`playbackId`,me,e),Vw(`playbackRates`,he,e),Vw(`metadata`,de,e),Vw(`disableCookies`,t.disableCookies??!1,e),Vw(`extraSourceParams`,ve,e),Vw(`_hlsConfig`,be,e),Vw(`themeProps`,_e,e),Vw(`castCustomData`,ye,e),Vw(`paused`,pe,e,(e,t)=>{t!=null&&(t?e.pause():e.play())},(e,t,n)=>e.hasAttribute(`autoplay`)&&!e.hasPlayed?!1:zw(e,t,n)),Vw(`currentTime`,ge,e,(e,t)=>{t!=null&&(e.currentTime=t)}),$(`abort`,e,n),$(`canplay`,e,r),$(`canplaythrough`,e,i),$(`emptied`,e,a),$(`loadstart`,e,o),$(`loadeddata`,e,s),$(`loadedmetadata`,e,c),$(`progress`,e,l),$(`durationchange`,e,u),$(`volumechange`,e,d),$(`ratechange`,e,f),$(`resize`,e,p),$(`waiting`,e,m),$(`play`,e,h),$(`playing`,e,ee),$(`timeupdate`,e,te),$(`pause`,e,ne),$(`seeking`,e,re),$(`seeked`,e,ie),$(`stalled`,e,ae),$(`suspend`,e,oe),$(`ended`,e,se),$(`error`,e,ce),$(`cuepointchange`,e,le),$(`chapterchange`,e,ue),[xe]},Kw=Uw(),qw=`mux-player-react`,Jw=o.forwardRef((e,t)=>{let n=(0,o.useRef)(null),r=Iw(n,t),[i]=Gw(n,e),[a]=(0,o.useState)(e.playerInitTime??fa());return o.createElement(Ww,{ref:r,defaultHiddenCaptions:e.defaultHiddenCaptions,playerSoftwareName:qw,playerSoftwareVersion:Kw,playerInitTime:a,...i})});export{fr as MaxResolution,C as MediaError,pr as MinResolution,mr as RenditionOrder,Jw as default,fa as generatePlayerInitTime,qw as playerSoftwareName,Kw as playerSoftwareVersion};
//# sourceMappingURL=dist-DtfEKPF0.js.map