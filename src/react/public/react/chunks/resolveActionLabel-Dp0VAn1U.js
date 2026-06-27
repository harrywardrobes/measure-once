function a(s,i,_,t){const e=String(i||"").toLowerCase(),n=String(_||"").toLowerCase(),r=s;if(n){const o=`${e}|${n}`;return o in r?r[o]??"":r[`${e}|`]??r["__global__|"]??""}if(t){const o=r[`${e}|${String(t).toLowerCase()}`];if(o)return o}return r[`${e}|`]??r["__global__|"]??""}export{a as r};
//# sourceMappingURL=resolveActionLabel-Dp0VAn1U.js.map
