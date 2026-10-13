/* Reading progress: fills .navbar-progress_fill (style panel: gold, scaleX(0), inside the 2px .navbar-progress track on the navbar's bottom edge) as the reader moves through [data-reading-progress] (journal body, Beliefs pages' articles). 0 when the article's top meets the navbar, 1 when its end reaches the bottom of the screen. Pages without the attribute leave the fill at zero, so only the track shows.
   Read time: any [data-read-time] on the page (the journal post meta row) gets "N min read" for that same article, at 230 words a minute, never under 1. */
(function(){var a=document.querySelector('[data-reading-progress]'),b=document.querySelector('.navbar-progress_fill');if(!a)return;
var t=document.querySelectorAll('[data-read-time]');if(t.length){var w=(a.textContent.match(/\S+/g)||[]).length,m=Math.max(1,Math.round(w/230))+' min read';for(var i=0;i<t.length;i++)t[i].textContent=m}
if(!b)return;var f=0;
function u(){f=0;var n=b.parentNode.getBoundingClientRect().bottom,r=a.getBoundingClientRect(),d=r.height-(innerHeight-n),p=d>0?(n-r.top)/d:(r.top<n?1:0);b.style.transform='scaleX('+(p<0?0:p>1?1:p)+')'}
function q(){if(!f)f=requestAnimationFrame(u)}
addEventListener('scroll',q,{passive:true});addEventListener('resize',q);u()})();
