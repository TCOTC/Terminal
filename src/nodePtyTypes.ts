/**
 * 本仓库不声明 node-pty npm 依赖，仅保留插件实际用到的最小类型，
 * 运行时从 temp 缓存目录 require 官方包。
 */

export interface IDisposable {
    dispose(): void;
}

export interface IPty {
    kill(signal?: string | number): void;
    resize(columns: number, rows: number): void;
    write(data: string): void;
    onData(callback: (data: string) => void): IDisposable;
    onExit(callback: (e?: {exitCode: number; signal?: number}) => void): IDisposable;
}

export interface NodePtySpawnOptions {
    name?: string;
    cols?: number;
    rows?: number;
    cwd?: string;
    env?: {[key: string]: string | undefined};
}

export interface NodePtyModule {
    spawn(file: string, args: string[] | string, options: NodePtySpawnOptions): IPty;
}
