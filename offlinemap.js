OfflineLayer = L.TileLayer.extend({
    initialize: function (url, options) {
        L.TileLayer.prototype.initialize.call(this, url, options);

        this._onReady = options["onReady"];
        this._onError = options["onError"];
        var storeName = options["storeName"] || 'OfflineLeafletTileImages';

        this._hasBeenCanceled = false;
        this._nbTilesLeftToSave = 0;
        this._nbTilesWithError = 0;
        this._maxNbCachedZoomLevels = 10;

        this._tileImagesStore = new IDBStore({
            dbVersion: 1,
            storeName: storeName,
            keyPath: null,
            autoIncrement: false
        }, this._onReady);
    },

    _setUpTile: function (tile, key, value) {
        // Start loading the tile with either the cached tile image or the result of getTileUrl
        tile.src = value;
        this.fire('tileloadstart', {
            tile: tile,
            url: tile.src
        });
    },

    _loadTile: function (tile, tilePoint) {
        // Reproducing TileLayer._loadTile behavior, but the tile.src will be set later
        tile._layer = this;
        tile.onerror = this._tileOnError;
        this._adjustTilePoint(tilePoint);
        tile.onload = this._tileOnLoad;
        // Done reproducing _loadTile

        var self = this;
        var onSuccess = function(dbEntry){
            if(dbEntry){
                self._setUpTile(tile, key, dbEntry.image);
            }
            else{
                self._setUpTile(tile, key, self.getTileUrl(tilePoint));
            }
        }

        var onError = function() {
            // Error while getting the key from the DB
            self._setUpTile(tile, key, this.getTileUrl(tilePoint));
            if(self._onError){
                self._onError();
            }
        }

        var key = this._createTileKey(tilePoint.x, tilePoint.y, tilePoint.z);
        this._tileImagesStore.get(key, onSuccess, onError);
    },

    _updateTotalNbImagesLeftToSave: function(nbTiles){
        this._nbTilesLeftToSave = nbTiles;
        this._progressControls.updateTotalNbTilesLeftToSave(this._nbTilesLeftToSave);
    },

    _decrementNbTilesLeftToSave: function(){
        this._nbTilesLeftToSave--;
        this._progressControls.updateNbTilesLeftToSave(this._nbTilesLeftToSave);
    },

    _incrementNbTilesWithError: function(){
        this._nbTilesWithError++;
    },

    cancel: function(){
        this._hasBeenCanceled = true;
    },

    clearTiles: function(){
        this._tileImagesStore.clear();
    },

    calculateNbTiles: function(){
        self._myQueue = null;
    },

    isBusy: function(){
        return !!this._myQueue;
    },

    saveTiles: function(){
        if(!this._progressControls){
            this._progressControls = new ProgressControl();
            this._progressControls.setOfflineLayer(this);
            this._map.addControl(this._progressControls);
        }

        this._hasBeenCanceled = false;

        var startingZoom = this._getZoomForUrl();
        var maxZoom = this._map.getMaxZoom();
        var minZoom = 0;
        console.log("actualZoom: " + startingZoom);

        var nbZoomLevelsToCache = maxZoom - startingZoom;
        if(nbZoomLevelsToCache > this._maxNbCachedZoomLevels){
            alert("Not possible to save more than " + this._maxNbCachedZoomLevels + " zoom levels.")
        }

        if(this._myQueue){
            alert("system is busy.")
            return;
        }

        this._tileImagesToQuery = {};

        for(var tile in this._tiles){
            var split = tile.split(":");
            var x = parseInt(split[0]);
            var y = parseInt(split[1]);
            this._getZoomedInTiles(x, y, startingZoom, maxZoom);
            this._getZoomedOutTiles(Math.floor(x/2), Math.floor(y/2), startingZoom - 1, minZoom);
        }

        var tileImagesToQueryArray = [];
        for(var key in this._tileImagesToQuery){
            tileImagesToQueryArray.push(key);
        }

        var self = this;
        this._tileImagesStore.getBatch(tileImagesToQueryArray, function(items){
            self._myQueue = queue(8);
            var i = 0;
            self._progressControls.evaluating();
            self._nbTilesLeftToSave = 0;
            items.forEach(function (item){
                if(item){
                    // image already exist
                }
                else{
                    var key = tileImagesToQueryArray[i];
                    var tileInfo = self._tileImagesToQuery[key];

                    self._nbTilesLeftToSave++;

                    var makingAjaxCall = function(url, callback, error, queueCallback){
                        self._ajax(url, callback, error, queueCallback);
                    }

                    var gettingImage = function (response) {
                        self._tileImagesStore.put(key, {"image": self._arrayBufferToBase64ImagePNG(response)});
                        self._decrementNbTilesLeftToSave();
                    }

                    var errorGettingImage = function (){
                        self._incrementNbTilesWithError();
                        self._decrementNbTilesLeftToSave();
                        if(this._onError){
                            this._onError();
                        }
                    };

                    self._myQueue.defer(makingAjaxCall, self._createURL(tileInfo.x, tileInfo.y, tileInfo.z),
                                        gettingImage, errorGettingImage);
                }

                i++;
            });

            self._updateTotalNbImagesLeftToSave(self._nbTilesLeftToSave);

            self._myQueue.awaitAll(function(error, data) {
                self._myQueue = null;
            });
        }, this._onBatchQueryError, 'dense');
    },

    _getZoomedInTiles: function(x, y, currentZ, maxZ){
        this._getTileImage(x, y, currentZ);

        if(currentZ < maxZ){
            // getting the 4 tile under the current tile
            this._getZoomedInTiles(x * 2, y * 2, currentZ + 1, maxZ);
            this._getZoomedInTiles(x * 2 + 1, y * 2, currentZ + 1, maxZ);
            this._getZoomedInTiles(x * 2, y * 2 + 1, currentZ + 1, maxZ);
            this._getZoomedInTiles(x * 2 + 1, y * 2 + 1, currentZ + 1, maxZ);
        }
    },

    _getZoomedOutTiles: function(x, y, currentZ, finalZ){
        this._getTileImage(x, y, currentZ);
        if(currentZ > finalZ){
            this._getZoomedOutTiles(Math.floor(x / 2), Math.floor(y / 2), currentZ - 1, finalZ);
        }
    },

    _getTileImage: function(x, y, z){
        // At this point, we only add the image to a "dictionary"
        // This is being done to avoid multiple requests when zooming out, since zooming int should never overlap
        var key = this._createTileKey(x, y, z);
        if(!this._tileImagesToQuery[key]){
            this._tileImagesToQuery[key] = {key:key, x: x, y: y, z: z};
        }
    },

    _onBatchQueryError: function(){
        if(this._onError){
            this._onError();
        }
    },

    _createURL: function(x, y, z){
        var subdomainIndex = Math.abs(x + y) % this.options.subdomains.length;
        var subdomain = this.options.subdomains[subdomainIndex];
        return L.Util.template(mapquestUrl,
            L.extend({
                s: subdomain,
                z: z,
                x: x,
                y: y
            }, this.options));
    },

    // TAKEN FROM OfflineMap
    /*
     Probably btoa can work incorrect, you can override btoa with next example:
     https://developer.mozilla.org/en-US/docs/Web/JavaScript/Base64_encoding_and_decoding#Solution_.232_.E2.80.93_rewriting_atob%28%29_and_btoa%28%29_using_TypedArrays_and_UTF-8
     */
    _arrayBufferToBase64ImagePNG: function(buffer) {
        var binary = '';
        var bytes = new Uint8Array(buffer);
        for (var i = 0, l = bytes.byteLength; i < l; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return 'data:image/png;base64,' + btoa(binary);
    },

    _createTileKey: function(x, y, z){
        return x + ", " + y + ", " + z;
    },

    // TAKEN FROM OfflineMap
    _ajax: function(url, callback, error, queueCallback) {
        if(this._hasBeenCanceled){
            queueCallback();
            return;
        }

        var xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        xhr.responseType = 'arraybuffer';
        xhr.onload = function(err) {
            if (this.status == 200) {
                callback(this.response);
            }
            else{
                error();
            }
            queueCallback();
        };
        xhr.send();
    }
});

var ProgressControl = L.Control.extend({
    options: {
        position: 'topright'
    },

    onAdd: function (map) {
        var controls = L.DomUtil.create('div', 'offlinemap-controls', this._container);

        this._counter = L.DomUtil.create('div', 'offlinemap-controls-counter', controls);
        this._counter.innerHTML = "0";

        var cancelButton = L.DomUtil.create('img', 'offlinemap-controls-cancel-button', controls);
        cancelButton.setAttribute('src', "cancelBtn.png");

        L.DomEvent.addListener(cancelButton, 'click', this.onCancelClick, this);
        L.DomEvent.disableClickPropagation(cancelButton);

        return controls;
    },

    evaluating: function(){
        // Tiles will get downloaded and probably cached while we are still looking at the result from the DB
        // To avoid any weird display, we set _evaluating to false and display nothing until the total nb tiles
        // is known.
        this._evaluating = true;
        this._counter.innerHTML = "...";
    },

    updateTotalNbTilesLeftToSave: function (nbTiles){
        this._evaluating = false;
        this._nbTilesToSave = nbTiles;
        this.updateNbTilesLeftToSave(nbTiles);
    },

    updateNbTilesLeftToSave: function (nbTiles){
        if(!this._evaluating){
            if(this._nbTilesToSave == 0){
                this._counter.innerHTML = "100%";
            }
            else{
                this._counter.innerHTML = Math.floor((this._nbTilesToSave - nbTiles) / this._nbTilesToSave * 100) + "%";
            }
        }
    },

    onCancelClick: function (){
        this._offlineLayer.cancel();
    },

    setOfflineLayer: function (offlineLayer){
        this._offlineLayer = offlineLayer;
    }
});