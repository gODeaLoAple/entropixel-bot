import json
import shutil
import sys
import typing
from typing import List

import numpy as np
from PIL import Image
import os
from typing import Iterable, TypeVar, Any, Generator

T = TypeVar('T')
RESULT_DIR = "./result/"

class Point:
    def __init__(self, x, y):
        self.x = x
        self.y = y


class Size:
    def __init__(self, width, height):
        self.width = width
        self.height = height


class EnumColor:
    class Color(object):
        def __init__(self, index, name, rgb):
            self.name = name
            self.rgb = rgb
            self.index = index

    ENUM = [
        Color(0, 'black', (34, 34, 34)),
        Color(1, 'white', (228, 228, 228)),
        Color(2, 'grey', (136, 136, 136)),
        Color(3, 'white', (255, 255, 255)),
        Color(4, 'pink', (255, 167, 209)),
        Color(5, 'red', (229, 0, 0)),
        Color(6, 'orange', (229, 149, 0)),
        Color(7, 'brown', (160, 106, 66)),
        Color(8, 'yellow', (229, 217, 0)),
        Color(9, 'conifer', (148, 224, 68)),
        Color(10, 'green', (2, 190, 1)),
        Color(11, 'dark turquoise', (0, 211, 221)),
        Color(12, 'pacific blue', (0, 131, 199)),
        Color(13, 'blue', (0, 0, 234)),
        Color(14, 'violet', (207, 110, 228)),
        Color(15, 'purple', (130, 0, 128))
    ]

    @staticmethod
    def get_closest(target):
        for color in EnumColor.ENUM:
            if np.array_equal(target, color.rgb):
                return color

        best_color = EnumColor.ENUM[0]
        best_dist = float("+inf")

        for color in EnumColor.ENUM:
            distance = np.linalg.norm(np.array(target) - np.array(color.rgb))
            if distance < best_dist:
                best_dist = distance
                best_color = color

        return best_color


class ColoredPoint(Point):
    def __init__(self, x, y, color: EnumColor.Color):
        super().__init__(x, y)
        self.color = color

    def __add__(self, other):
        if isinstance(other, Point):
            return ColoredPoint(self.x + other.x, self.y + other.y, self.color)

    def to_dto(self):
        return {"x": self.x, "y": self.y, "color": self.color.index}

    def put_on(self, img: Image):
        img.putpixel((self.x, self.y), self.color.rgb)


class TemplateWriter:
    def __init__(self):
        with open("./script.js", "r", encoding="utf8") as f:
            self.template = "".join(f.readlines())

    def write(self, file, points, fileid):
        with open(file, 'w') as f:
            content = (self.template
                       .replace("//PYTHON", f"main({str(points)});")
                       .replace("const FILE_ID = null;", f"const FILE_ID = {fileid};"))
            f.write(content)


def generate_points(width, height):
    for y in range(height):
        for x in range(width):
            yield x, y


def clear_result():
    if os.path.exists(RESULT_DIR):
        shutil.rmtree(RESULT_DIR, )
    os.mkdir(RESULT_DIR)


def create_palette_image(except_colors):
    image = Image.new(mode='P', size=(1, 1))

    pallette = []
    for color in (x for x in EnumColor.ENUM if x.name not in except_colors):
        pallette.extend(color.rgb)

    image.putpalette(pallette)

    return image


def transform_points(img, points):
    for x, y in points:
        pixel = img.getpixel((x, y))
        color = EnumColor.get_closest(pixel)
        yield ColoredPoint(x, y, color)


def batch(items: Iterable[T], size) -> Generator[List[T], Any, None]:
    chunk = []

    for x in items:
        chunk.append(x)
        if len(chunk) == size:
            yield chunk
            chunk = []

    if len(chunk) > 0:
        yield chunk


def filter_colors(colored_points: typing.Iterator[ColoredPoint], except_colors):
    return (x for x in colored_points if x.color.name not in except_colors)


def create_new_image(image, size, except_colors, do_resample=False):
    if do_resample:
        pImage = create_palette_image(except_colors)
        return (image
                .resize(size=(size.width, size.height),
                        resample=Image.Resampling.LANCZOS)
                .quantize(kmeans=0,
                          palette=pImage,
                          method=Image.Quantize.MAXCOVERAGE,
                          dither=Image.Dither.FLOYDSTEINBERG)
                .convert('RGB'))
    return image.resize(size=(size.width, size.height))


def create_chunk_file_path(index):
    return os.path.join(RESULT_DIR, f"chunk_{index}.js")

def write(filename, size: Size, parts_count, offset: Point):
    template_writer = TemplateWriter()
    clear_result()
    except_colors = []

    image = Image.open(filename).convert("RGB")
    new_image = create_new_image(image, size, except_colors, do_resample=False)

    copy = new_image.copy()

    points = list(generate_points(new_image.width, new_image.height))
    # random.shuffle(points)
    batches = batch(filter_colors(transform_points(new_image, points), except_colors), parts_count)
    for index, colors in enumerate(batches):
        for colored_point in colors:
            colored_point.put_on(copy)
        template_writer.write(create_chunk_file_path(index), [(x + offset).to_dto() for x in colors], index)

    copy.show()


def split_to_chunks(filename, chunks_count):
    template_writer = TemplateWriter()
    clear_result()

    with open(filename, "r", encoding="utf8") as f:
        arr = json.load(f)

    for i, data in enumerate(batch(arr, chunks_count)):
        template_writer.write(create_chunk_file_path(i), list(data), i)


def main(args: List[str]):
    program = args[1]

    if program == "create":
        filename = args[2]
        size = Size(int(args[3]), int(args[4]))
        chunk_size = int(args[5])
        offset = Point(int(args[6]), int(args[7]))
        write(filename, size, chunk_size, offset)
    elif program == "split":
        filename = args[2]
        chunk_size = int(args[3])
        split_to_chunks(filename, chunk_size)
    else:
        raise ValueError(f"Program {program} not found")


if __name__ == '__main__':
    args = sys.argv
    main(args)
