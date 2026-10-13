/* Scroll-to-top: shown only on pages taller than 3 screens, once scrolled past 1.5 screens (1 screen on phones). The style panel owns the look; this toggles .is-visible (+ inert while hidden) and does the scroll. */
(function(){var b=document.querySelector('.scroll-to-top_button');if(!b)return;var phone=matchMedia('(max-width: 767px)'),still=matchMedia('(prefers-reduced-motion: reduce)'),f=0;
function u(){f=0;var h=innerHeight,s=document.documentElement.scrollHeight>h*3&&scrollY>h*(phone.matches?1:1.5);b.classList.toggle('is-visible',s);b.toggleAttribute('inert',!s)}
function q(){if(!f)f=requestAnimationFrame(u)}
addEventListener('scroll',q,{passive:true});addEventListener('resize',q);
b.addEventListener('click',function(){scrollTo({top:0,behavior:still.matches?'auto':'smooth'})});u()})();
