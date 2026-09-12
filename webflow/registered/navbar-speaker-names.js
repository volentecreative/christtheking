/* Media card speaker names. Contract + why: webflow/README.md. */
(function(){'use strict';
var D=document,KEY='ctk-speakers-2',SRC='/media',map=null,t;
function norm(s){return (s||'').replace(/\s+/g,' ').trim().toLowerCase();}
function slug(h){return h?h.replace(/[?#].*$/,'').replace(/\/+$/,'').split('/').pop():'';}
function paint(){if(!map)return;
D.querySelectorAll('[data-speakers-target]').forEach(function(el){
if(el.hasAttribute('data-speakers-done'))return;
var a=el.closest('a[href]'),p=el.parentElement,h=p&&p.querySelector('[data-media-title]'),
v=map[slug(a&&a.getAttribute('href'))]||map[norm(h&&h.textContent)];
if(v){el.textContent=v;el.setAttribute('data-speakers-done','');}});}
function harvest(doc){var m={};
doc.querySelectorAll('[data-speaker-source]').forEach(function(it){var n=[];
it.querySelectorAll('[data-speaker-name]').forEach(function(p){
var x=p.textContent.trim();if(x&&n.indexOf(x)<0)n.push(x);});
if(!n.length)return;
var v=n.join(', '),k=it.querySelector('[data-speaker-key]'),i=it.querySelector('[data-speaker-title]');
if(k)m[slug(norm(k.textContent))]=v;
if(i)m[norm(i.textContent)]=v;});
delete m[''];return m;}
function use(m){if(!m||!Object.keys(m).length)return 0;map=m;paint();
try{sessionStorage.setItem(KEY,JSON.stringify(m));}catch(e){}return 1;}
function run(){if(!D.querySelector('[data-speakers-target]'))return;
new MutationObserver(function(){clearTimeout(t);t=setTimeout(paint,50);})
.observe(D.body,{childList:true,subtree:true});
if(location.pathname.replace(/\/+$/,'')===SRC){use(harvest(D));return;}
var c=null;try{c=sessionStorage.getItem(KEY);}catch(e){}
if(c&&use(JSON.parse(c)))return;
fetch(SRC,{credentials:'same-origin'}).then(function(r){return r.ok?r.text():Promise.reject(0);})
.then(function(h){use(harvest(new DOMParser().parseFromString(h,'text/html')));})
.catch(function(){});}
if(D.readyState==='loading')D.addEventListener('DOMContentLoaded',run);else run();
})();
