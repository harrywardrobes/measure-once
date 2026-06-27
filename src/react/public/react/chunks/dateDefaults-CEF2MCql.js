function n(t){return String(t).padStart(2,"0")}function e(){const t=new Date;return`${t.getFullYear()}-${n(t.getMonth()+1)}-${n(t.getDate())}`}function r(){const t=new Date;return`${n(t.getHours())}:${n(t.getMinutes())}`}function a(){return`${e()}T${r()}`}export{a,e as n};
//# sourceMappingURL=dateDefaults-CEF2MCql.js.map
