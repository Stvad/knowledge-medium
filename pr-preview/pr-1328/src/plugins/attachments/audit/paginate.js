async function e(e){let t=[];for(let n=0;;){let r=await e(n);if(r.length===0)return t;t.push(...r),n+=r.length}}export{e as collectPaged};
//# sourceMappingURL=paginate.js.map