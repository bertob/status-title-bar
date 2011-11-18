
const St = imports.gi.St;
const Main = imports.ui.main;
const Panel = imports.ui.panel;
const Tweener = imports.ui.tweener;
const Shell = imports.gi.Shell;
const PopupMenu = imports.ui.popupMenu;
const PanelMenu = imports.ui.panelMenu;
const Clutter = imports.gi.Clutter;
const Lang = imports.lang;
const Overview = imports.ui.overview;
const Meta = imports.gi.Meta;
const Util = imports.misc.util;

const PANEL_ICON_SIZE = 24;

/**
 * AppMenuButton:
 *
 * This class manages the "application menu" component.  It tracks the
 * currently focused application.  However, when an app is launched,
 * this menu also handles startup notification for it.  So when we
 * have an active startup notification, we switch modes to display that.
 */
function AppMenuButton() {
    this._init();
}

AppMenuButton.prototype = {
    __proto__: PanelMenu.Button.prototype,

    _init: function() {
        PanelMenu.Button.prototype._init.call(this, 0.0);
        this._startingApps = [];

        this._targetApp = null;

        let bin = new St.Bin({ name: 'windowTitle' });
        this.actor.add_actor(bin);

        this.actor.reactive = false;
        this._targetIsCurrent = false;

        this._container = new Shell.GenericContainer();
        bin.set_child(this._container);
        this._container.connect('get-preferred-width', Lang.bind(this, this._getContentPreferredWidth));
        this._container.connect('get-preferred-height', Lang.bind(this, this._getContentPreferredHeight));
        this._container.connect('allocate', Lang.bind(this, this._contentAllocate));

        this._iconBox = new Shell.Slicer({ name: 'appMenuIcon' });
        this._iconBox.connect('style-changed',
                              Lang.bind(this, this._onIconBoxStyleChanged));
        this._iconBox.connect('notify::allocation',
                              Lang.bind(this, this._updateIconBoxClip));
        this._container.add_actor(this._iconBox);
        this._label = new Panel.TextShadower();
        this._container.add_actor(this._label.actor);

        this._iconBottomClip = 0;

        this._quitMenu = new PopupMenu.PopupMenuItem('');
        this.menu.addMenuItem(this._quitMenu);
        this._quitMenu.connect('activate', Lang.bind(this, this._onQuit));

        this._visible = !Main.overview.visible;
        if (!this._visible)
            this.actor.hide();
        Main.overview.connect('hiding', Lang.bind(this, function () {
            this.show();
        }));
        Main.overview.connect('showing', Lang.bind(this, function () {
            this.hide();
        }));

        this._stop = true;

        this._spinner = new Panel.AnimatedIcon('process-working.svg',
                                         PANEL_ICON_SIZE);
        this._container.add_actor(this._spinner.actor);
        this._spinner.actor.lower_bottom();

        let tracker = Shell.WindowTracker.get_default();
        let appSys = Shell.AppSystem.get_default();
        tracker.connect('notify::focus-app', Lang.bind(this, this._syncApp));
        appSys.connect('app-state-changed', Lang.bind(this, this._onAppStateChanged));

        global.window_manager.connect('switch-workspace', Lang.bind(this, this._switchWorkspaces));

		global.window_manager.connect("maximize", Lang.bind(this, this._onMaximize));
		global.window_manager.connect("unmaximize", Lang.bind(this, this._onUnmaximize));
//		global.screen.connect("notify::n-workspaces", Lang.bind(this, this._changeWorkspaces));

		this._windows = [];
		this._workspaces = [];

		this._switchWorkspaces();
//		this._changeWorkspaces();
    },

    show: function() {
        if (this._visible)
            return;

        this._visible = true;
        this.actor.show();
        this.actor.reactive = true;

        if (!this._targetIsCurrent)
            return;

        Tweener.removeTweens(this.actor);
        Tweener.addTween(this.actor,
                         { opacity: 255,
                           time: Overview.ANIMATION_TIME,
                           transition: 'easeOutQuad' });
    },

    hide: function() {
        if (!this._visible)
            return;

        this._visible = false;
        this.actor.reactive = false;
        if (!this._targetIsCurrent) {
            this.actor.hide();
            return;
        }

        Tweener.removeTweens(this.actor);
        Tweener.addTween(this.actor,
                         { opacity: 0,
                           time: Overview.ANIMATION_TIME,
                           transition: 'easeOutQuad',
                           onComplete: function() {
                               this.actor.hide();
                           },
                           onCompleteScope: this });
    },

    _onIconBoxStyleChanged: function() {
        let node = this._iconBox.get_theme_node();
        this._iconBottomClip = node.get_length('app-icon-bottom-clip');
        this._updateIconBoxClip();
    },

    _updateIconBoxClip: function() {
        let allocation = this._iconBox.allocation;
        if (this._iconBottomClip > 0)
            this._iconBox.set_clip(0, 0,
                                   allocation.x2 - allocation.x1,
                                   allocation.y2 - allocation.y1 - this._iconBottomClip);
        else
            this._iconBox.remove_clip();
    },

    stopAnimation: function() {
        if (this._stop)
            return;

        this._stop = true;
        Tweener.addTween(this._spinner.actor,
                         { opacity: 0,
                           time: SPINNER_ANIMATION_TIME,
                           transition: "easeOutQuad",
                           onCompleteScope: this,
                           onComplete: function() {
                               this._spinner.actor.opacity = 255;
                               this._spinner.actor.hide();
                           }
                         });
    },

    startAnimation: function() {
        this._stop = false;
        this._spinner.actor.show();
    },

    _getContentPreferredWidth: function(actor, forHeight, alloc) {
        let [minSize, naturalSize] = this._iconBox.get_preferred_width(forHeight);
        alloc.min_size = minSize;
        alloc.natural_size = naturalSize;
        [minSize, naturalSize] = this._label.actor.get_preferred_width(forHeight);
        alloc.min_size = alloc.min_size + Math.max(0, minSize - Math.floor(alloc.min_size / 2));
        alloc.natural_size = alloc.natural_size + Math.max(0, naturalSize - Math.floor(alloc.natural_size / 2));
    },

    _getContentPreferredHeight: function(actor, forWidth, alloc) {
        let [minSize, naturalSize] = this._iconBox.get_preferred_height(forWidth);
        alloc.min_size = minSize;
        alloc.natural_size = naturalSize;
        [minSize, naturalSize] = this._label.actor.get_preferred_height(forWidth);
        if (minSize > alloc.min_size)
            alloc.min_size = minSize;
        if (naturalSize > alloc.natural_size)
            alloc.natural_size = naturalSize;
    },

	// TODO: Find optimal width!
    _contentAllocate: function(actor, box, flags) {
        let allocWidth = box.x2 - box.x1;
        let allocHeight = box.y2 - box.y1;
        let childBox = new Clutter.ActorBox();

        let [minWidth, minHeight, naturalWidth, naturalHeight] = this._iconBox.get_preferred_size();

        let direction = this.actor.get_direction();

        let yPadding = Math.floor(Math.max(0, allocHeight - naturalHeight) / 2);
        childBox.y1 = yPadding;
        childBox.y2 = childBox.y1 + Math.min(naturalHeight, allocHeight);
        if (direction == St.TextDirection.LTR) {
            childBox.x1 = 0;
            childBox.x2 = childBox.x1 + Math.min(naturalWidth, allocWidth);
//            childBox.x2 = childBox.x1 + Math.max(naturalWidth, allocWidth);
        } else {
            childBox.x1 = Math.max(0, allocWidth - naturalWidth);
            childBox.x2 = allocWidth;
        }
        this._iconBox.allocate(childBox, flags);

        let iconWidth = childBox.x2 - childBox.x1;

        [minWidth, minHeight, naturalWidth, naturalHeight] = this._label.actor.get_preferred_size();

        yPadding = Math.floor(Math.max(0, allocHeight - naturalHeight) / 2);
        childBox.y1 = yPadding;
        childBox.y2 = childBox.y1 + Math.min(naturalHeight, allocHeight);

        if (direction == St.TextDirection.LTR) {
            childBox.x1 = Math.floor(iconWidth / 2);
//            childBox.x2 = Math.min(childBox.x1 + naturalWidth, allocWidth);
            childBox.x2 = Math.max(childBox.x1 + naturalWidth, allocWidth);
        } else {
            childBox.x2 = allocWidth - Math.floor(iconWidth / 2);
            childBox.x1 = Math.max(0, childBox.x2 - naturalWidth);
        }
        this._label.actor.allocate(childBox, flags);

        if (direction == St.TextDirection.LTR) {
            childBox.x1 = Math.floor(iconWidth / 2) + this._label.actor.width;
            childBox.x2 = childBox.x1 + this._spinner.actor.width;
            childBox.y1 = box.y1;
            childBox.y2 = box.y2 - 1;
            this._spinner.actor.allocate(childBox, flags);
        } else {
            childBox.x1 = -this._spinner.actor.width;
            childBox.x2 = childBox.x1 + this._spinner.actor.width;
            childBox.y1 = box.y1;
            childBox.y2 = box.y2 - 1;
            this._spinner.actor.allocate(childBox, flags);
        }
    },

    _onQuit: function() {
        if (this._targetApp == null)
            return;
        this._targetApp.request_quit();
    },

    _onAppStateChanged: function(appSys, app) {
        let state = app.state;
        if (state != Shell.AppState.STARTING) {
            this._startingApps = this._startingApps.filter(function(a) {
                return a != app;
            });
        } else if (state == Shell.AppState.STARTING) {
            this._startingApps.push(app);
        }
        // For now just resync on all running state changes; this is mainly to handle
        // cases where the focused window's application changes without the focus
        // changing.  An example case is how we map OpenOffice.org based on the window
        // title which is a dynamic property.
        this._syncApp();
    },

    _syncApp: function() {
        let tracker = Shell.WindowTracker.get_default();
        let lastStartedApp = null;
        let workspace = global.screen.get_active_workspace();
        for (let i = 0; i < this._startingApps.length; i++)
            if (this._startingApps[i].is_on_workspace(workspace))
                lastStartedApp = this._startingApps[i];

		let focusedApp = tracker.focus_app

        if (!focusedApp) {
            // If the app has just lost focus to the panel, pretend
            // nothing happened; otherwise you can't keynav to the
            // app menu.
            if (global.stage_input_mode == Shell.StageInputMode.FOCUSED)
                return;
        }

        let targetApp = focusedApp != null ? focusedApp : lastStartedApp;

        if (targetApp == null) {
            if (!this._targetIsCurrent)
                return;

            this.actor.reactive = false;
            this._targetIsCurrent = false;

            Tweener.removeTweens(this.actor);
            Tweener.addTween(this.actor, { opacity: 0,
                                           time: Overview.ANIMATION_TIME,
                                           transition: 'easeOutQuad' });
            return;
        }

        if (!this._targetIsCurrent) {
            this.actor.reactive = true;
            this._targetIsCurrent = true;

            Tweener.removeTweens(this.actor);
            Tweener.addTween(this.actor, { opacity: 255,
                                           time: Overview.ANIMATION_TIME,
                                           transition: 'easeOutQuad' });
        }

		this._updateTitleLabel(targetApp);
//		this._label.setText(targetApp.get_name());

        if (targetApp == this._targetApp) {
            if (targetApp && targetApp.get_state() != Shell.AppState.STARTING)
                this.stopAnimation();
            return;
        }

        this._spinner.actor.hide();
        if (this._iconBox.child != null)
            this._iconBox.child.destroy();
        this._iconBox.hide();

        this._targetApp = targetApp;
        let icon = targetApp.get_faded_icon(2 * PANEL_ICON_SIZE);

        // TODO - _quit() doesn't really work on apps in state STARTING yet
        this._quitMenu.label.set_text(_("Quit %s").format(targetApp.get_name()));

        this._iconBox.set_child(icon);
        this._iconBox.show();

        if (targetApp.get_state() == Shell.AppState.STARTING)
            this.startAnimation();

        this.emit('changed');
    },

	_updateTitleLabel: function(app) {
		this._label.setText("");

		for (let i = 0; i < this._windows.length; i++) {
			let win = this._windows[i];

			if (win.has_focus()) {
				this._changeTitle(win, app);
			}

		}

	},

	_onTitleChanged: function(win) {
		if (win.has_focus()) {
			let tracker = Shell.WindowTracker.get_default();
			let app = tracker.get_window_app(win);

			this._changeTitle(win, app);
		}
	},

	_changeTitle: function(win, app) {
		let maximizedFlags = Meta.MaximizeFlags.HORIZONTAL | Meta.MaximizeFlags.VERTICAL;

		if (win.get_maximized() == maximizedFlags) {
			this._label.setText(win.title);
		} else {
			this._label.setText(app.get_name());
		}
	},

	_onMaximize: function(shellwm, actor) {
		let win = actor.get_meta_window();

		this._onTitleChanged(win);
	},

	_onUnmaximize: function(shellwm, actor) {
		let win = actor.get_meta_window();

		this._onTitleChanged(win);
	},

	_windowAdded: function(metaWorkspace, metaWindow) {
		if (metaWorkspace != this._workspace) {
			return;
		}

		let tracker = Shell.WindowTracker.get_default();

		this._initWindow(metaWindow);

		if (this._windows.indexOf(metaWindow) == -1 && tracker.is_window_interesting(metaWindow)) {
			this._windows.push(metaWindow);
		}

    },

    _windowRemoved: function(metaWorkspace, metaWindow) {
		if (metaWorkspace != this._workspace) {
			return;
		}

		let windowIndex = this._windows.indexOf(metaWindow);

		if (windowIndex != -1) {
			windows.splice(windowIndex, 1);
		}

		this._syncApp();
    },

    _switchWorkspaces: function() {
		this._reset();

		this._workspace = global.screen.get_active_workspace();
		this._windows = this._workspace.list_windows();

		for (let i in this._windows) {
			let win = this._windows[i];

			this._initWindow(win);
		}

		this._workspace._windowAddedId = this._workspace.connect('window-added',
								Lang.bind(this, this._windowAdded));
		this._workspace._windowRemovedId = this._workspace.connect('window-removed',
								Lang.bind(this, this._windowRemoved));

		this._syncApp();
    },

	_initWindow: function(win) {
		if (!win._notifyTitleId) {
			win._notifyTitleId = win.connect("notify::title", Lang.bind(this, this._onTitleChanged));
		}
	},

	_reset: function() {
		let ws = this._workspace;

//			ws.disconnect(ws._windowAddedId);
//			ws.disconnect(ws._windowRemovedId);

		for ( let i = 0; i < this._windows.length; ++i ) {
//				windows[i].disconnect(win._notifyTitleId);
		}

		this._workspace = null;
		this._windows = [];
	}

};

let newAppMenuButton;

function init() {
}

function enable() {
	if (!newAppMenuButton) {
		newAppMenuButton = new AppMenuButton();
	}

	Main.panel._leftBox.remove_actor(Main.panel._appMenu.actor);
    let children = Main.panel._rightBox.get_children();

	Main.panel._leftBox.insert_actor(newAppMenuButton.actor, children.length-1);
	Main.panel._menus.addMenu(newAppMenuButton.menu);
}

function disable() {
	Main.panel._menus.removeMenu(newAppMenuButton.menu);
	Main.panel._leftBox.remove_actor(newAppMenuButton.actor);

    let children = Main.panel._rightBox.get_children();
	Main.panel._leftBox.insert_actor(Main.panel._appMenu.actor, children.length-1);

	newAppMenuButton = null;
}
