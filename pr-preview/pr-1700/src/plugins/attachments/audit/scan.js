async function e(e,t,n){let r=[];for(let i of e)try{r.push(await t(i))}catch(e){r.push(n(i,e))}return r}export{e as mapSettled};
//# sourceMappingURL=scan.js.map