/* Reading progress: fills .navbar-progress (style panel: 2px, pinned to the navbar's bottom edge, scaleX(0)) as the reader moves through [data-reading-progress] (journal body, Beliefs pages' articles). 0 when the article's top meets the navbar, 1 when its end reaches the bottom of the screen. Pages without the attribute never touch the bar. */
(function(){var a=document.querySelector('[data-reading-progress]'),b=document.querySelector('.navbar-progress');if(!a||!b)return;var f=0;
function u(){f=0;var n=b.parentNode.getBoundingClientRect().bottom,r=a.getBoundingClientRect(),d=r.height-(innerHeight-n),p=d>0?(n-r.top)/d:(r.top<n?1:0);b.style.transform='scaleX('+(p<0?0:p>1?1:p)+')'}
function q(){if(!f)f=requestAnimationFrame(u)}
addEventListener('scroll',q,{passive:true});addEventListener('resize',q);u()})();
