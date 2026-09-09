#define CANVAS_WIDTH 240
#define CANVAS_HEIGHT 120

static unsigned char pixels[CANVAS_WIDTH * CANVAS_HEIGHT * 4];

__attribute__((export_name("pixels_ptr")))
const unsigned char *pixels_ptr(void) {
	return pixels;
}

__attribute__((export_name("rect_render")))
void rect_render(int x, int y, int w, int h) {
	int x0 = x < 0 ? 0 : x;
	int y0 = y < 0 ? 0 : y;
	int x1 = x + w;
	int y1 = y + h;
	if (x1 > CANVAS_WIDTH) {
		x1 = CANVAS_WIDTH;
	}
	if (y1 > CANVAS_HEIGHT) {
		y1 = CANVAS_HEIGHT;
	}
	for (int row = y0; row < y1; row++) {
		for (int col = x0; col < x1; col++) {
			int i = (row * CANVAS_WIDTH + col) * 4;
			pixels[i] = 255;
			pixels[i + 1] = 0;
			pixels[i + 2] = 0;
			pixels[i + 3] = 255;
		}
	}
}
