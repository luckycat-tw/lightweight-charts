import { Binding as CanvasCoordinateSpaceBinding } from 'fancy-canvas/coordinate-space';

import { ensureNotNull } from '../helpers/assertions';
import { clearRect, clearRectWithGradient, drawScaled } from '../helpers/canvas-helpers';
import { Delegate } from '../helpers/delegate';
import { IDestroyable } from '../helpers/idestroyable';
import { ISubscription } from '../helpers/isubscription';

import { ChartModel, HoveredObject } from '../model/chart-model';
import { Coordinate } from '../model/coordinate';
import { IDataSource } from '../model/idata-source';
import { InvalidationLevel } from '../model/invalidate-mask';
import { IPriceDataSource } from '../model/iprice-data-source';
import { Pane } from '../model/pane';
import { Point } from '../model/point';
import { TimePointIndex } from '../model/time-data';
import { IPaneRenderer } from '../renderers/ipane-renderer';
import { IPaneView } from '../views/pane/ipane-view';

import { createBoundCanvas, getContext2D, Size } from './canvas-utils';
import { ChartWidget } from './chart-widget';
import { KineticAnimation } from './kinetic-animation';
import { MouseEventHandler, Position, TouchMouseEvent } from './mouse-event-handler';
import { PriceAxisWidget, PriceAxisWidgetSide } from './price-axis-widget';
import { isMobile, mobileTouch } from './support-touch';

// actually we should check what event happened (touch or mouse)
// not check current UA to detect "mobile" device
const trackCrosshairOnlyAfterLongTap = isMobile;

const enum Constants {
	MinScrollSpeed = 0.2,
	MaxScrollSpeed = 7,
	DumpingCoeff = 0.997,
	ScrollMinMove = 15,
}

type DrawFunction = (renderer: IPaneRenderer, ctx: CanvasRenderingContext2D, pixelRatio: number, isHovered: boolean, hitTestData?: unknown) => void;

function drawBackground(renderer: IPaneRenderer, ctx: CanvasRenderingContext2D, pixelRatio: number, isHovered: boolean, hitTestData?: unknown): void {
	if (renderer.drawBackground) {
		renderer.drawBackground(ctx, pixelRatio, isHovered, hitTestData);
	}
}

function drawForeground(renderer: IPaneRenderer, ctx: CanvasRenderingContext2D, pixelRatio: number, isHovered: boolean, hitTestData?: unknown): void {
	renderer.draw(ctx, pixelRatio, isHovered, hitTestData);
}

type PaneViewsGetter = (source: IDataSource, pane: Pane) => readonly IPaneView[];

function sourcePaneViews(source: IDataSource, pane: Pane): readonly IPaneView[] {
	return source.paneViews(pane);
}

function sourceTopPaneViews(source: IDataSource, pane: Pane): readonly IPaneView[] {
	return source.topPaneViews !== undefined ? source.topPaneViews(pane) : [];
}

export interface HitTestResult {
	source: IPriceDataSource;
	object?: HoveredObject;
	view: IPaneView;
}

interface HitTestPaneViewResult {
	view: IPaneView;
	object?: HoveredObject;
}

interface StartScrollPosition extends Point {
	timestamp: number;
	localX: Coordinate;
	localY: Coordinate;
}

export class PaneWidget implements IDestroyable {
	private readonly _chart: ChartWidget;
	private _state: Pane | null;
	private _size: Size = new Size(0, 0);
	private _leftPriceAxisWidget: PriceAxisWidget | null = null;
	private _rightPriceAxisWidget: PriceAxisWidget | null = null;
	private readonly _paneCell: HTMLElement;
	private readonly _leftAxisCell: HTMLElement;
	private readonly _rightAxisCell: HTMLElement;
	private readonly _canvasBinding: CanvasCoordinateSpaceBinding;
	private readonly _topCanvasBinding: CanvasCoordinateSpaceBinding;
	private readonly _rowElement: HTMLElement;
	private readonly _mouseEventHandler: MouseEventHandler;
	private _startScrollingPos: StartScrollPosition | null = null;
	private _isScrolling: boolean = false;
	private _clicked: Delegate<TimePointIndex | null, Point> = new Delegate();
	private _prevPinchScale: number = 0;
	private _longTap: boolean = false;
	private _startTrackPoint: Point | null = null;
	private _exitTrackingModeOnNextTry: boolean = false;
	private _initCrosshairPosition: Point | null = null;
	private _scrollXAnimation: KineticAnimation | null = null;

	public constructor(chart: ChartWidget, state: Pane) {
		this._chart = chart;

		this._state = state;
		this._state.onDestroyed().subscribe(this._onStateDestroyed.bind(this), this, true);

		this._paneCell = document.createElement('td');
		this._paneCell.style.padding = '0';
		this._paneCell.style.position = 'relative';

		const paneWrapper = document.createElement('div');
		paneWrapper.style.width = '100%';
		paneWrapper.style.height = '100%';
		paneWrapper.style.position = 'relative';
		paneWrapper.style.overflow = 'hidden';

		this._leftAxisCell = document.createElement('td');
		this._leftAxisCell.style.padding = '0';

		this._rightAxisCell = document.createElement('td');
		this._rightAxisCell.style.padding = '0';

		this._paneCell.appendChild(paneWrapper);

		this._canvasBinding = createBoundCanvas(paneWrapper, new Size(16, 16));
		this._canvasBinding.subscribeCanvasConfigured(this._canvasConfiguredHandler);
		const canvas = this._canvasBinding.canvas;
		canvas.style.position = 'absolute';
		canvas.style.zIndex = '1';
		canvas.style.left = '0';
		canvas.style.top = '0';

		this._topCanvasBinding = createBoundCanvas(paneWrapper, new Size(16, 16));
		this._topCanvasBinding.subscribeCanvasConfigured(this._topCanvasConfiguredHandler);
		const topCanvas = this._topCanvasBinding.canvas;
		topCanvas.style.position = 'absolute';
		topCanvas.style.zIndex = '2';
		topCanvas.style.left = '0';
		topCanvas.style.top = '0';

		this._rowElement = document.createElement('tr');
		this._rowElement.appendChild(this._leftAxisCell);
		this._rowElement.appendChild(this._paneCell);
		this._rowElement.appendChild(this._rightAxisCell);
		this.updatePriceAxisWidgets();

		const scrollOptions = this.chart().options().handleScroll;
		this._mouseEventHandler = new MouseEventHandler(
			this._topCanvasBinding.canvas,
			this,
			{
				treatVertTouchDragAsPageScroll: !scrollOptions.vertTouchDrag,
				treatHorzTouchDragAsPageScroll: !scrollOptions.horzTouchDrag,
			}
		);
	}

	public destroy(): void {
		if (this._leftPriceAxisWidget !== null) {
			this._leftPriceAxisWidget.destroy();
		}
		if (this._rightPriceAxisWidget !== null) {
			this._rightPriceAxisWidget.destroy();
		}

		this._topCanvasBinding.unsubscribeCanvasConfigured(this._topCanvasConfiguredHandler);
		this._topCanvasBinding.destroy();

		this._canvasBinding.unsubscribeCanvasConfigured(this._canvasConfiguredHandler);
		this._canvasBinding.destroy();

		if (this._state !== null) {
			this._state.onDestroyed().unsubscribeAll(this);
		}

		this._mouseEventHandler.destroy();
	}

	public state(): Pane {
		return ensureNotNull(this._state);
	}

	public setState(pane: Pane | null): void {
		if (this._state !== null) {
			this._state.onDestroyed().unsubscribeAll(this);
		}

		this._state = pane;

		if (this._state !== null) {
			this._state.onDestroyed().subscribe(PaneWidget.prototype._onStateDestroyed.bind(this), this, true);
		}

		this.updatePriceAxisWidgets();
	}

	public chart(): ChartWidget {
		return this._chart;
	}

	public getElement(): HTMLElement {
		return this._rowElement;
	}

	public updatePriceAxisWidgets(): void {
		if (this._state === null) {
			return;
		}

		this._recreatePriceAxisWidgets();
		if (this._model().serieses().length === 0) {
			return;
		}

		if (this._leftPriceAxisWidget !== null) {
			const leftPriceScale = this._state.leftPriceScale();
			this._leftPriceAxisWidget.setPriceScale(ensureNotNull(leftPriceScale));
		}
		if (this._rightPriceAxisWidget !== null) {
			const rightPriceScale = this._state.rightPriceScale();
			this._rightPriceAxisWidget.setPriceScale(ensureNotNull(rightPriceScale));
		}
	}

	public stretchFactor(): number {
		return this._state !== null ? this._state.stretchFactor() : 0;
	}

	public setStretchFactor(stretchFactor: number): void {
		if (this._state) {
			this._state.setStretchFactor(stretchFactor);
		}
	}

	public mouseEnterEvent(event: TouchMouseEvent): void {
		if (!this._state) {
			return;
		}

		const x = event.localX;
		const y = event.localY;

		if (!mobileTouch) {
			this._setCrosshairPosition(x, y);
		}
	}

	public mouseDownEvent(event: TouchMouseEvent): void {
		this._longTap = false;
		this._exitTrackingModeOnNextTry = this._startTrackPoint !== null;

		if (!this._state) {
			return;
		}

		this._terminateKineticAnimation();

		if (document.activeElement !== document.body && document.activeElement !== document.documentElement) {
			// If any focusable element except the page itself is focused, remove the focus
			(ensureNotNull(document.activeElement) as HTMLElement).blur();
		} else {
			// Clear selection
			const selection = document.getSelection();
			if (selection !== null) {
				selection.removeAllRanges();
			}
		}

		const model = this._model();

		const priceScale = this._state.defaultPriceScale();

		if (priceScale.isEmpty() || model.timeScale().isEmpty()) {
			return;
		}

		if (this._startTrackPoint !== null) {
			const crosshair = model.crosshairSource();
			this._initCrosshairPosition = { x: crosshair.appliedX(), y: crosshair.appliedY() };
			this._startTrackPoint = { x: event.localX, y: event.localY };
		}

		if (!mobileTouch) {
			this._setCrosshairPosition(event.localX, event.localY);
		}
	}

	public mouseMoveEvent(event: TouchMouseEvent): void {
		if (!this._state) {
			return;
		}

		const x = event.localX;
		const y = event.localY;

		if (this._preventCrosshairMove()) {
			this._clearCrosshairPosition();
		}

		if (!mobileTouch) {
			this._setCrosshairPosition(x, y);
			const hitTest = this.hitTest(x, y);
			this._model().setHoveredSource(hitTest && { source: hitTest.source, object: hitTest.object });
			if (hitTest !== null && hitTest.view.moveHandler !== undefined) {
				hitTest.view.moveHandler(x, y);
			}
		}
	}

	public mouseClickEvent(event: TouchMouseEvent): void {
		if (this._state === null) {
			return;
		}

		const x = event.localX;
		const y = event.localY;
		const hitTest = this.hitTest(x, y);
		if (hitTest !== null && hitTest.view.clickHandler !== undefined) {
			hitTest.view.clickHandler(x, y);
		}

		if (this._clicked.hasListeners()) {
			const currentTime = this._model().crosshairSource().appliedIndex();
			this._clicked.fire(currentTime, { x, y });
		}

		this._tryExitTrackingMode();
	}

	// eslint-disable-next-line complexity
	public pressedMouseMoveEvent(event: TouchMouseEvent): void {
		if (this._state === null) {
			return;
		}

		const model = this._model();
		const x = event.localX;
		const y = event.localY;

		if (this._startTrackPoint !== null) {
			// tracking mode: move crosshair
			this._exitTrackingModeOnNextTry = false;
			const origPoint = ensureNotNull(this._initCrosshairPosition);
			const newX = origPoint.x + (x - this._startTrackPoint.x) as Coordinate;
			const newY = origPoint.y + (y - this._startTrackPoint.y) as Coordinate;
			this._setCrosshairPosition(newX, newY);
		} else if (!this._preventCrosshairMove()) {
			this._setCrosshairPosition(x, y);
		}

		if (model.timeScale().isEmpty()) {
			return;
		}

		const chartOptions = this._chart.options();
		const scrollOptions = chartOptions.handleScroll;
		const kineticScrollOptions = chartOptions.kineticScroll;
		if (
			(!scrollOptions.pressedMouseMove || event.type === 'touch') &&
			(!scrollOptions.horzTouchDrag && !scrollOptions.vertTouchDrag || event.type === 'mouse')
		) {
			return;
		}

		const priceScale = this._state.defaultPriceScale();

		const now = performance.now();

		if (this._startScrollingPos === null && !this._preventScroll()) {
			this._startScrollingPos = {
				x: event.clientX,
				y: event.clientY,
				timestamp: now,
				localX: event.localX,
				localY: event.localY,
			};
		}

		if (this._scrollXAnimation !== null) {
			this._scrollXAnimation.addPosition(event.localX, now);
		}

		if (
			this._startScrollingPos !== null &&
			!this._isScrolling &&
			(this._startScrollingPos.x !== event.clientX || this._startScrollingPos.y !== event.clientY)
		) {
			if (
				this._scrollXAnimation === null && (
					event.type === 'touch' && kineticScrollOptions.touch ||
					event.type === 'mouse' && kineticScrollOptions.mouse
				)
			) {
				this._scrollXAnimation = new KineticAnimation(
					Constants.MinScrollSpeed,
					Constants.MaxScrollSpeed,
					Constants.DumpingCoeff,
					Constants.ScrollMinMove
				);
				this._scrollXAnimation.addPosition(this._startScrollingPos.localX, this._startScrollingPos.timestamp);
				this._scrollXAnimation.addPosition(event.localX, now);
			}

			if (!priceScale.isEmpty()) {
				model.startScrollPrice(this._state, priceScale, event.localY);
			}

			model.startScrollTime(event.localX);
			this._isScrolling = true;
		}

		if (this._isScrolling) {
			// this allows scrolling not default price scales
			if (!priceScale.isEmpty()) {
				model.scrollPriceTo(this._state, priceScale, event.localY);
			}

			model.scrollTimeTo(event.localX);
		}
	}

	public mouseUpEvent(event: TouchMouseEvent): void {
		if (this._state === null) {
			return;
		}

		this._longTap = false;

		this._endScroll(event);
	}

	public longTapEvent(event: TouchMouseEvent): void {
		this._longTap = true;

		if (this._startTrackPoint === null && trackCrosshairOnlyAfterLongTap) {
			const point: Point = { x: event.localX, y: event.localY };
			this._startTrackingMode(point, point);
		}
	}

	public mouseLeaveEvent(event: TouchMouseEvent): void {
		if (this._state === null) {
			return;
		}

		this._state.model().setHoveredSource(null);

		if (!isMobile) {
			this._clearCrosshairPosition();
		}
	}

	public clicked(): ISubscription<TimePointIndex | null, Point> {
		return this._clicked;
	}

	public pinchStartEvent(): void {
		this._prevPinchScale = 1;
		this._terminateKineticAnimation();
	}

	public pinchEvent(middlePoint: Position, scale: number): void {
		if (!this._chart.options().handleScale.pinch) {
			return;
		}

		const zoomScale = (scale - this._prevPinchScale) * 5;
		this._prevPinchScale = scale;

		this._model().zoomTime(middlePoint.x as Coordinate, zoomScale);
	}

	public hitTest(x: Coordinate, y: Coordinate): HitTestResult | null {
		const state = this._state;
		if (state === null) {
			return null;
		}

		const sources = state.orderedSources();
		for (const source of sources) {
			const sourceResult = this._hitTestPaneView(source.paneViews(state), x, y);
			if (sourceResult !== null) {
				return {
					source: source,
					view: sourceResult.view,
					object: sourceResult.object,
				};
			}
		}

		return null;
	}

	public setPriceAxisSize(width: number, position: PriceAxisWidgetSide): void {
		const priceAxisWidget = position === 'left' ? this._leftPriceAxisWidget : this._rightPriceAxisWidget;
		ensureNotNull(priceAxisWidget).setSize(new Size(width, this._size.h));
	}

	public getSize(): Size {
		return this._size;
	}

	public setSize(size: Size): void {
		if (size.w < 0 || size.h < 0) {
			throw new Error('Try to set invalid size to PaneWidget ' + JSON.stringify(size));
		}

		if (this._size.equals(size)) {
			return;
		}

		this._size = size;

		this._canvasBinding.resizeCanvas({ width: size.w, height: size.h });
		this._topCanvasBinding.resizeCanvas({ width: size.w, height: size.h });

		this._paneCell.style.width = size.w + 'px';
		this._paneCell.style.height = size.h + 'px';
	}

	public recalculatePriceScales(): void {
		const pane = ensureNotNull(this._state);
		pane.recalculatePriceScale(pane.leftPriceScale());
		pane.recalculatePriceScale(pane.rightPriceScale());

		for (const source of pane.dataSources()) {
			if (pane.isOverlay(source)) {
				const priceScale = source.priceScale();
				if (priceScale !== null) {
					pane.recalculatePriceScale(priceScale);
				}

				// for overlay drawings price scale is owner's price scale
				// however owner's price scale could not contain ds
				source.updateAllViews();
			}
		}
	}

	public getImage(): HTMLCanvasElement {
		return this._canvasBinding.canvas;
	}

	public paint(type: InvalidationLevel): void {
		if (type === InvalidationLevel.None) {
			return;
		}

		if (this._state === null) {
			return;
		}

		if (type > InvalidationLevel.Cursor) {
			this.recalculatePriceScales();
		}

		if (this._leftPriceAxisWidget !== null) {
			this._leftPriceAxisWidget.paint(type);
		}
		if (this._rightPriceAxisWidget !== null) {
			this._rightPriceAxisWidget.paint(type);
		}

		if (type !== InvalidationLevel.Cursor) {
			const ctx = getContext2D(this._canvasBinding.canvas);
			ctx.save();
			this._drawBackground(ctx, this._canvasBinding.pixelRatio);
			if (this._state) {
				this._drawGrid(ctx, this._canvasBinding.pixelRatio);
				this._drawWatermark(ctx, this._canvasBinding.pixelRatio);
				this._drawSources(ctx, this._canvasBinding.pixelRatio, sourcePaneViews);
			}
			ctx.restore();
		}

		const topCtx = getContext2D(this._topCanvasBinding.canvas);
		topCtx.clearRect(0, 0, Math.ceil(this._size.w * this._topCanvasBinding.pixelRatio), Math.ceil(this._size.h * this._topCanvasBinding.pixelRatio));
		this._drawSources(topCtx, this._canvasBinding.pixelRatio, sourceTopPaneViews);
		this._drawCrosshair(topCtx, this._topCanvasBinding.pixelRatio);
	}

	public leftPriceAxisWidget(): PriceAxisWidget | null {
		return this._leftPriceAxisWidget;
	}

	public rightPriceAxisWidget(): PriceAxisWidget | null {
		return this._rightPriceAxisWidget;
	}

	private _onStateDestroyed(): void {
		if (this._state !== null) {
			this._state.onDestroyed().unsubscribeAll(this);
		}

		this._state = null;
	}

	private _drawBackground(ctx: CanvasRenderingContext2D, pixelRatio: number): void {
		drawScaled(ctx, pixelRatio, () => {
			const model = this._model();
			const topColor = model.backgroundTopColor();
			const bottomColor = model.backgroundBottomColor();

			if (topColor === bottomColor) {
				clearRect(ctx, 0, 0, this._size.w, this._size.h, bottomColor);
			} else {
				clearRectWithGradient(ctx, 0, 0, this._size.w, this._size.h, topColor, bottomColor);
			}
		});
	}

	private _drawGrid(ctx: CanvasRenderingContext2D, pixelRatio: number): void {
		const state = ensureNotNull(this._state);
		const paneView = state.grid().paneView();
		const renderer = paneView.renderer(state.height(), state.width());

		if (renderer !== null) {
			ctx.save();
			renderer.draw(ctx, pixelRatio, false);
			ctx.restore();
		}
	}

	private _drawWatermark(ctx: CanvasRenderingContext2D, pixelRatio: number): void {
		const source = this._model().watermarkSource();
		this._drawSourceImpl(ctx, pixelRatio, sourcePaneViews, drawBackground, source);
		this._drawSourceImpl(ctx, pixelRatio, sourcePaneViews, drawForeground, source);
	}

	private _drawCrosshair(ctx: CanvasRenderingContext2D, pixelRatio: number): void {
		this._drawSourceImpl(ctx, pixelRatio, sourcePaneViews, drawForeground, this._model().crosshairSource());
	}

	private _drawSources(ctx: CanvasRenderingContext2D, pixelRatio: number, paneViewsGetter: PaneViewsGetter): void {
		const state = ensureNotNull(this._state);
		const sources = state.orderedSources();

		for (const source of sources) {
			this._drawSourceImpl(ctx, pixelRatio, paneViewsGetter, drawBackground, source);
		}

		for (const source of sources) {
			this._drawSourceImpl(ctx, pixelRatio, paneViewsGetter, drawForeground, source);
		}
	}

	private _drawSourceImpl(
		ctx: CanvasRenderingContext2D,
		pixelRatio: number,
		paneViewsGetter: PaneViewsGetter,
		drawFn: DrawFunction,
		source: IDataSource
	): void {
		const state = ensureNotNull(this._state);
		const paneViews = paneViewsGetter(source, state);
		const height = state.height();
		const width = state.width();
		const hoveredSource = state.model().hoveredSource();
		const isHovered = hoveredSource !== null && hoveredSource.source === source;
		const objecId = hoveredSource !== null && isHovered && hoveredSource.object !== undefined
			? hoveredSource.object.hitTestData
			: undefined;

		for (const paneView of paneViews) {
			const renderer = paneView.renderer(height, width);
			if (renderer !== null) {
				ctx.save();
				drawFn(renderer, ctx, pixelRatio, isHovered, objecId);
				ctx.restore();
			}
		}
	}

	private _hitTestPaneView(paneViews: readonly IPaneView[], x: Coordinate, y: Coordinate): HitTestPaneViewResult | null {
		for (const paneView of paneViews) {
			const renderer = paneView.renderer(this._size.h, this._size.w);
			if (renderer !== null && renderer.hitTest) {
				const result = renderer.hitTest(x, y);
				if (result !== null) {
					return {
						view: paneView,
						object: result,
					};
				}
			}
		}

		return null;
	}

	private _recreatePriceAxisWidgets(): void {
		if (this._state === null) {
			return;
		}
		const chart = this._chart;
		const leftAxisVisible = this._state.leftPriceScale().options().visible;
		const rightAxisVisible = this._state.rightPriceScale().options().visible;
		if (!leftAxisVisible && this._leftPriceAxisWidget !== null) {
			this._leftAxisCell.removeChild(this._leftPriceAxisWidget.getElement());
			this._leftPriceAxisWidget.destroy();
			this._leftPriceAxisWidget = null;
		}
		if (!rightAxisVisible && this._rightPriceAxisWidget !== null) {
			this._rightAxisCell.removeChild(this._rightPriceAxisWidget.getElement());
			this._rightPriceAxisWidget.destroy();
			this._rightPriceAxisWidget = null;
		}
		const rendererOptionsProvider = chart.model().rendererOptionsProvider();
		if (leftAxisVisible && this._leftPriceAxisWidget === null) {
			this._leftPriceAxisWidget = new PriceAxisWidget(this, chart.options().layout, rendererOptionsProvider, 'left');
			this._leftAxisCell.appendChild(this._leftPriceAxisWidget.getElement());
		}
		if (rightAxisVisible && this._rightPriceAxisWidget === null) {
			this._rightPriceAxisWidget = new PriceAxisWidget(this, chart.options().layout, rendererOptionsProvider, 'right');
			this._rightAxisCell.appendChild(this._rightPriceAxisWidget.getElement());
		}
	}

	private _preventCrosshairMove(): boolean {
		return trackCrosshairOnlyAfterLongTap && this._startTrackPoint === null;
	}

	private _preventScroll(): boolean {
		return trackCrosshairOnlyAfterLongTap && this._longTap || this._startTrackPoint !== null;
	}

	private _correctXCoord(x: Coordinate): Coordinate {
		return Math.max(0, Math.min(x, this._size.w - 1)) as Coordinate;
	}

	private _correctYCoord(y: Coordinate): Coordinate {
		return Math.max(0, Math.min(y, this._size.h - 1)) as Coordinate;
	}

	private _setCrosshairPosition(x: Coordinate, y: Coordinate): void {
		this._model().setAndSaveCurrentPosition(this._correctXCoord(x), this._correctYCoord(y), ensureNotNull(this._state));
	}

	private _clearCrosshairPosition(): void {
		this._model().clearCurrentPosition();
	}

	private _tryExitTrackingMode(): void {
		if (this._exitTrackingModeOnNextTry) {
			this._startTrackPoint = null;
			this._clearCrosshairPosition();
		}
	}

	private _startTrackingMode(startTrackPoint: Point, crossHairPosition: Point): void {
		this._startTrackPoint = startTrackPoint;
		this._exitTrackingModeOnNextTry = false;
		this._setCrosshairPosition(crossHairPosition.x, crossHairPosition.y);
		const crosshair = this._model().crosshairSource();
		this._initCrosshairPosition = { x: crosshair.appliedX(), y: crosshair.appliedY() };
	}

	private _model(): ChartModel {
		return this._chart.model();
	}

	private _finishScroll(): void {
		const model = this._model();
		const state = this.state();
		const priceScale = state.defaultPriceScale();

		model.endScrollPrice(state, priceScale);
		model.endScrollTime();
		this._startScrollingPos = null;
		this._isScrolling = false;
	}

	private _endScroll(event: TouchMouseEvent): void {
		if (!this._isScrolling) {
			return;
		}

		const startAnimationTime = performance.now();

		if (this._scrollXAnimation !== null) {
			this._scrollXAnimation.start(event.localX, startAnimationTime);
		}

		if ((this._scrollXAnimation === null || this._scrollXAnimation.finished(startAnimationTime))) {
			// animation is not needed
			this._finishScroll();
			return;
		}

		const model = this._model();
		const timeScale = model.timeScale();

		const scrollXAnimation = this._scrollXAnimation;

		const animationFn = () => {
			if ((scrollXAnimation.terminated())) {
				// animation terminated, see _terminateKineticAnimation
				return;
			}

			const now = performance.now();

			let xAnimationFinished = scrollXAnimation.finished(now);
			if (!scrollXAnimation.terminated()) {
				const prevRightOffset = timeScale.rightOffset();
				model.scrollTimeTo(scrollXAnimation.getPosition(now));
				if (prevRightOffset === timeScale.rightOffset()) {
					xAnimationFinished = true;
					this._scrollXAnimation = null;
				}
			}

			if (xAnimationFinished) {
				this._finishScroll();
				return;
			}

			requestAnimationFrame(animationFn);
		};

		requestAnimationFrame(animationFn);
	}

	private _terminateKineticAnimation(): void {
		const now = performance.now();
		const xAnimationFinished = this._scrollXAnimation === null || this._scrollXAnimation.finished(now);
		if (this._scrollXAnimation !== null) {
			if (!xAnimationFinished) {
				this._finishScroll();
			}
		}

		if (this._scrollXAnimation !== null) {
			this._scrollXAnimation.terminate();
			this._scrollXAnimation = null;
		}
	}

	private readonly _canvasConfiguredHandler = () => this._state && this._model().lightUpdate();
	private readonly _topCanvasConfiguredHandler = () => this._state && this._model().lightUpdate();
}
