import type { ChartWidgetDefinition } from './types';

class WidgetRegistryClass {
  private widgets: Map<string, ChartWidgetDefinition> = new Map();

  register(widget: ChartWidgetDefinition): void {
    this.widgets.set(widget.id, widget);
  }

  getWidgets(): ChartWidgetDefinition[] {
    return Array.from(this.widgets.values());
  }

  getWidget(id: string): ChartWidgetDefinition | undefined {
    return this.widgets.get(id);
  }

  unregister(id: string): boolean {
    return this.widgets.delete(id);
  }
}

export const WidgetRegistry = new WidgetRegistryClass();
