declare module 'plotly.js-basic-dist-min' {
  type PlotData = Record<string, unknown>;
  type PlotLayout = Record<string, unknown>;
  type PlotConfig = Record<string, unknown>;
  const Plotly: {
    newPlot(el: HTMLElement, data: PlotData[], layout?: PlotLayout, config?: PlotConfig): Promise<unknown>;
    react(el: HTMLElement, data: PlotData[], layout?: PlotLayout, config?: PlotConfig): Promise<unknown>;
    purge(el: HTMLElement): void;
    relayout(el: HTMLElement, layout: PlotLayout): Promise<unknown>;
  };
  export default Plotly;
}
