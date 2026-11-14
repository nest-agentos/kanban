/** Independent board reads have bounded concurrency; one board retains chunk order. */
export async function forEachRecordScope<T>(values:Iterable<T>,read:(value:T)=>Promise<void>):Promise<void> {
    const rows=[...values];let next=0;
    await Promise.all(Array.from({length:Math.min(rows.length,8)},async()=>{
        while(next<rows.length)await read(rows[next++]);
    }));
}
